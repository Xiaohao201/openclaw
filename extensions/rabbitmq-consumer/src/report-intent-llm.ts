import type { PluginLogger, PluginRuntime } from "../api.js";
import { extractMessageText } from "./message-text.js";
import type { ReportPeriod } from "./report-trigger.js";

/**
 * Minimal subagent surface this arbiter needs. Declared structurally (not as
 * the full PluginRuntime["subagent"]) so tests can mock it without the
 * deprecated methods, and so an older runtime missing deleteSession still
 * type-checks. Mirrors TopicPickerSubagent.
 */
export type ReportIntentSubagent = Pick<
  PluginRuntime["subagent"],
  "run" | "waitForRun" | "getSessionMessages"
> &
  Partial<Pick<PluginRuntime["subagent"], "deleteSession">>;

export interface ReportIntentDeps {
  /** Instruction-only slice from detectReportRequest — never the pasted body. */
  instruction: string;
  /** Period the deterministic layer guessed; the model may override it. */
  hintedPeriod: ReportPeriod | null;
  subagent: ReportIntentSubagent;
  /** Trusted userId; scopes the throwaway session (never from tool params). */
  userId: string;
  /** Uniqueness token (e.g. historyId) so concurrent classifications collide. */
  token: string | number;
  logger: PluginLogger;
  /** Wait budget. Kept short: this runs before the user sees any ACK. */
  timeoutMs?: number;
}

export interface ReportIntentVerdict {
  isReport: boolean;
  period: ReportPeriod | null;
}

/**
 * Short by design — this sits in front of the user's first byte of feedback.
 * On timeout we fall back to "not a report", which costs the user one explicit
 * re-ask instead of hijacking their turn with a report they never wanted.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

const PERIODS: ReportPeriod[] = ["日报", "周报", "月报"];

const CLASSIFIER_SYSTEM_PROMPT =
  "你是一个意图分类器。禁止调用任何工具、禁止查询数据库、禁止解释，" +
  "只输出题目要求的 JSON 对象，不要代码块。";

/** Build the classification message from the instruction slice. */
function buildMessage(instruction: string, hintedPeriod: ReportPeriod | null): string {
  return [
    "判断下面这句用户输入，是不是在【要求系统生成一份舆情日报/周报/月报】。",
    "",
    `用户输入：${JSON.stringify(instruction)}`,
    "",
    "判为 true 的情形：用户明确要一份周期性舆情报告，例如“出个周报”“把上周舆情汇总成简报”。",
    "判为 false 的情形（务必从严）：",
    "· 句中的“日报/周报/月报”只是媒体名称或引用来源（如“时代周报”“人民日报”“每周质量报告”）；",
    "· 用户是让你续写、润色、点评、翻译某段已有材料，或撰写报告中的某个章节；",
    "· 用户在问数据、问情况、闲聊，并没有要一份完整周期报告。",
    "",
    hintedPeriod ? `若判为 true，周期默认取「${hintedPeriod}」，除非用户明说了别的周期。` : "",
    '只输出一个 JSON 对象：{"isReport": true/false, "period": "日报"|"周报"|"月报"|null}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** The latest assistant turn's text, or null when there is none. */
function latestAssistantText(messages: unknown[]): string | null {
  for (const msg of [...messages].toReversed()) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role === "assistant") {
      const text = extractMessageText(m.content).trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

/**
 * Extract the verdict from the model's reply. Scans for the last {...} block so
 * trailing prose or a code fence around the JSON does not break parsing.
 * Anything unparseable is treated as "not a report".
 */
function parseVerdict(messages: unknown[]): ReportIntentVerdict | null {
  const text = latestAssistantText(messages);
  if (!text) {
    return null;
  }
  const blocks = text.match(/\{[^{}]*\}/g);
  if (!blocks) {
    return null;
  }
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1]) as {
      isReport?: unknown;
      period?: unknown;
    };
    if (parsed.isReport !== true) {
      return { isReport: false, period: null };
    }
    const period = PERIODS.find((p) => p === parsed.period) ?? null;
    return { isReport: true, period };
  } catch {
    return null;
  }
}

/**
 * Ask the model whether an ambiguous message really asks for a 日/周/月报.
 *
 * Only reached when `detectReportRequest` returns `ambiguous`, so ordinary
 * chat never pays for it. The run is isolated (own session key, deliver:false)
 * and torn down after, so it neither streams to the frontend nor pollutes the
 * user's chat history — same shape as the topic picker.
 *
 * Fails closed: an unavailable model, a timeout, or an unparseable reply all
 * yield `{ isReport: false }`. Wrongly generating a report replaces the user's
 * real request; wrongly skipping one only costs them a clearer re-ask.
 */
export async function classifyReportIntent(deps: ReportIntentDeps): Promise<ReportIntentVerdict> {
  const { instruction, hintedPeriod, subagent, userId, token, logger } = deps;
  const negative: ReportIntentVerdict = { isReport: false, period: null };
  if (!instruction.trim()) {
    return negative;
  }

  const sessionKey = `agent:rabbitmq-${userId}:report-intent:${userId}:${token}`;
  try {
    const { runId } = await subagent.run({
      sessionKey,
      message: buildMessage(instruction, hintedPeriod),
      extraSystemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      deliver: false,
      idempotencyKey: `report-intent:${userId}:${token}`,
    });
    const wait = await subagent.waitForRun({
      runId,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (wait.status !== "ok") {
      logger.warn(
        `[REPORT_INTENT] classify run ${wait.status} for user ${userId}; treating as normal chat`,
      );
      return negative;
    }

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    const verdict = parseVerdict(messages);
    if (!verdict) {
      logger.warn(
        `[REPORT_INTENT] unparseable verdict for user ${userId}; treating as normal chat`,
      );
      return negative;
    }
    logger.info(
      `[REPORT_INTENT] user ${userId}: isReport=${verdict.isReport} period=${verdict.period ?? "-"}`,
    );
    return verdict.isReport ? { isReport: true, period: verdict.period ?? hintedPeriod } : negative;
  } catch (err) {
    logger.warn(`[REPORT_INTENT] classify failed for user ${userId}: ${String(err)}; normal chat`);
    return negative;
  } finally {
    // Best-effort cleanup; a leftover throwaway session is harmless.
    try {
      await subagent.deleteSession?.({ sessionKey, deleteTranscript: true });
    } catch {
      // ignore
    }
  }
}
