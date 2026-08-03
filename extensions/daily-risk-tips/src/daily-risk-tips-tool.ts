import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi, type PluginRuntime } from "../api.js";
import { collectAssistantTexts } from "./message-text.js";
import {
  buildGenerationUserMessage,
  buildStyleExtractionUserMessage,
  extractStyleRules,
  STYLE_EXTRACTION_SYSTEM_PROMPT,
  stripLayout,
  tryExtractJsonStyleRules,
} from "./prompts.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * The retrieval turn gets a much tighter budget than generation: it is OPTIONAL (its
 * only product is a style prompt that has a usable fallback), and the frontend arms a
 * 90s watchdog that is only rearmed by Mercure events. This tool is a single tool call
 * that emits nothing between its start and end steps, so any silent stretch past 90s
 * surfaces to the user as "处理超时：未收到响应" even though the backend is still working.
 */
const DEFAULT_STYLE_TIMEOUT_MS = 45_000;
/** After a failed/empty retrieval turn, skip it entirely for this long (auto-recovers). */
const DEFAULT_RETRIEVAL_COOLDOWN_MS = 600_000;
const DEFAULT_SOURCE_COLLECTION = "DailyRiskTips";
const DEFAULT_EMBEDDING_PROFILE = "doubao";
const DEFAULT_TOP_K = 10;
const DEFAULT_QUERY_MAX_CHARS = 6000;
/** Generous enough to cover the retrieval turn's milvus_search tool-call round trip. */
const SESSION_MESSAGES_LIMIT = 20;
const FALLBACK_STYLE_PROMPT =
  "你是深圳市网信办的舆情分析师，未检索到可参考的历史定稿案例，请严格按照用户消息中的<输出要求>撰写内容。";

/** Same gateway-subagent fallback as risk-judge's resolveSubagent — see that file for why this is needed. */
const GATEWAY_SUBAGENT_SYMBOL = Symbol.for("openclaw.plugin.gatewaySubagentRuntime");

function resolveSubagent(api: OpenClawPluginApi): PluginRuntime["subagent"] | undefined {
  const holder = (globalThis as Record<PropertyKey, unknown>)[GATEWAY_SUBAGENT_SYMBOL] as
    | { subagent?: PluginRuntime["subagent"] }
    | undefined;
  return holder?.subagent ?? api.runtime?.subagent;
}

const DailyRiskTipsSchema = Type.Object(
  {
    message: Type.String({
      description:
        "背景信息：具体的政策、事件或社会现象。Required. 会作为风险提示正文的唯一素材来源。",
    }),
    requirement: Type.Optional(
      Type.String({ description: "特殊要求：对本条风险提示的额外关注点或写作要求。Optional." }),
    ),
  },
  { additionalProperties: false },
);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface DailyRiskTipsConfig {
  timeoutMs: number;
  styleTimeoutMs: number;
  retrievalCooldownMs: number;
  sourceCollection: string;
  embeddingProfile: string;
  topK: number;
  queryMaxChars: number;
}

function resolveConfig(raw: Record<string, unknown>): DailyRiskTipsConfig {
  const t = raw.timeoutMs;
  const styleT = raw.styleTimeoutMs;
  const cooldown = raw.retrievalCooldownMs;
  const topK = raw.topK;
  const queryMaxChars = raw.queryMaxChars;
  const sourceCollection = raw.sourceCollection;
  const embeddingProfile = raw.embeddingProfile;
  return {
    timeoutMs: typeof t === "number" && t > 0 ? t : DEFAULT_TIMEOUT_MS,
    styleTimeoutMs: typeof styleT === "number" && styleT > 0 ? styleT : DEFAULT_STYLE_TIMEOUT_MS,
    retrievalCooldownMs:
      typeof cooldown === "number" && cooldown >= 0 ? cooldown : DEFAULT_RETRIEVAL_COOLDOWN_MS,
    sourceCollection:
      typeof sourceCollection === "string" && sourceCollection.trim()
        ? sourceCollection.trim()
        : DEFAULT_SOURCE_COLLECTION,
    embeddingProfile:
      typeof embeddingProfile === "string" && embeddingProfile.trim()
        ? embeddingProfile.trim()
        : DEFAULT_EMBEDDING_PROFILE,
    topK: typeof topK === "number" && topK > 0 ? topK : DEFAULT_TOP_K,
    queryMaxChars:
      typeof queryMaxChars === "number" && queryMaxChars > 0
        ? queryMaxChars
        : DEFAULT_QUERY_MAX_CHARS,
  };
}

interface StyleExtractionArgs {
  api: OpenClawPluginApi;
  subagent: PluginRuntime["subagent"];
  sessionKey: string;
  query: string;
  config: DailyRiskTipsConfig;
}

/**
 * Run the OPTIONAL retrieval/style-distillation turn. Returns "" for every failure mode
 * (turn error, timeout, no parsable answer) rather than throwing, so the caller can fall
 * back to the generic style prompt and trip the cooldown — a dead embedding provider must
 * not cost every later call a full styleTimeoutMs of silence.
 */
async function runStyleExtractionTurn(args: StyleExtractionArgs): Promise<string> {
  const { api, subagent, sessionKey, query, config } = args;
  const run = await subagent.run({
    sessionKey,
    message: buildStyleExtractionUserMessage({
      query,
      collection: config.sourceCollection,
      embeddingProfile: config.embeddingProfile,
      topK: config.topK,
    }),
    extraSystemPrompt: STYLE_EXTRACTION_SYSTEM_PROMPT,
    deliver: false,
  });
  const wait = await subagent.waitForRun({ runId: run.runId, timeoutMs: config.styleTimeoutMs });
  if (wait.status !== "ok") {
    api.logger.warn(`[DAILY_RISK_TIPS] style-extraction turn ${wait.status}: ${wait.error ?? ""}`);
    return "";
  }
  const session = await subagent.getSessionMessages({ sessionKey, limit: SESSION_MESSAGES_LIMIT });
  const assistantTexts = collectAssistantTexts(session.messages);
  // Prefer a message that strictly parses as the {"prompt": "..."} answer over any
  // prose (e.g. a closing remark after the retrieval tool call) that merely happens
  // to be non-empty once loosely extracted.
  return (
    assistantTexts.map((text) => tryExtractJsonStyleRules(text)).find((r) => r !== null) ??
    assistantTexts.map((text) => extractStyleRules(text)).find((r) => r.trim()) ??
    ""
  );
}

/**
 * Factory for the `daily_risk_tips` tool. Runs two isolated, non-delivered subagent
 * turns: turn A retrieves similar finalized examples via the milvus_search tool and
 * distills a style prompt from them; turn B uses that style prompt to write the new
 * risk tip. Mirrors risk-judge's ephemeral-session pattern.
 */
export function createDailyRiskTipsToolFactory(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});
  /**
   * Circuit breaker for the retrieval turn. Deliberately process-wide rather than
   * per-agent: Milvus reachability and the embedding provider's billing state are
   * global facts, so one agent discovering the outage should spare all the others.
   */
  let retrievalDisabledUntil = 0;

  return (ctx: { agentId?: string; sessionId?: string }) => {
    return {
      name: "daily_risk_tips",
      label: "每日风险提示",
      description:
        "生成一条符合深圳市网信办撰写规范的每日风险提示（≤150字）：先检索 Milvus 中人工审核定稿的历史范例，" +
        "提炼写作规则，再据此撰写新内容。当用户要求『生成每日风险提示』『写一条风险提示』时调用本工具。",
      parameters: DailyRiskTipsSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const message = asString(rawParams.message);
        if (!message) {
          return jsonResult({ success: false, error: "message is required (背景信息)." });
        }
        const requirement = asString(rawParams.requirement);

        const subagent = resolveSubagent(api);
        if (!subagent) {
          api.logger.error("[DAILY_RISK_TIPS] subagent runtime unavailable");
          return jsonResult({ success: false, error: "Model runtime is unavailable." });
        }

        const agentPart = ctx.agentId ? `agent:${ctx.agentId}:` : "";
        const sessionBase = `${agentPart}daily-risk-tips:${ctx.sessionId ?? "adhoc"}:${Date.now()}`;
        const styleSessionKey = `${sessionBase}:style`;
        const generateSessionKey = `${sessionBase}:generate`;
        const cleanup = async () => {
          for (const sessionKey of [styleSessionKey, generateSessionKey]) {
            try {
              await subagent.deleteSession({ sessionKey });
            } catch {
              // ignore — session GC is not critical to the result
            }
          }
        };

        try {
          // Turn A (optional): retrieve similar finalized examples via milvus_search and
          // distill style rules. Every failure degrades to FALLBACK_STYLE_PROMPT instead of
          // failing the tool — a tip written from generic rules beats an error, and aborting
          // here used to burn the caller's whole latency budget for nothing.
          const startedAt = Date.now();
          let styleRules = "";
          if (startedAt < retrievalDisabledUntil) {
            api.logger.info(
              "[DAILY_RISK_TIPS] retrieval turn suppressed for another " +
                `${Math.ceil((retrievalDisabledUntil - startedAt) / 1000)}s after an earlier failure`,
            );
          } else {
            styleRules = await runStyleExtractionTurn({
              api,
              subagent,
              sessionKey: styleSessionKey,
              query: message.slice(0, config.queryMaxChars),
              config,
            });
            if (!styleRules.trim()) {
              retrievalDisabledUntil = Date.now() + config.retrievalCooldownMs;
              api.logger.warn(
                "[DAILY_RISK_TIPS] no style rules from the retrieval turn; falling back and " +
                  `suppressing retrieval for ${Math.round(config.retrievalCooldownMs / 1000)}s`,
              );
            }
          }

          // Turn B: write the new risk tip using the distilled (or fallback) style rules.
          const runB = await subagent.run({
            sessionKey: generateSessionKey,
            message: buildGenerationUserMessage({ message, requirement }),
            extraSystemPrompt: styleRules.trim() ? styleRules : FALLBACK_STYLE_PROMPT,
            deliver: false,
          });
          const waitB = await subagent.waitForRun({
            runId: runB.runId,
            timeoutMs: config.timeoutMs,
          });
          if (waitB.status !== "ok") {
            api.logger.warn(
              `[DAILY_RISK_TIPS] generation turn ${waitB.status}: ${waitB.error ?? ""}`,
            );
            return jsonResult({
              success: false,
              error: waitB.status === "timeout" ? "生成超时，请稍后重试。" : "生成失败。",
            });
          }
          const sessionB = await subagent.getSessionMessages({
            sessionKey: generateSessionKey,
            limit: SESSION_MESSAGES_LIMIT,
          });
          const rawTip = collectAssistantTexts(sessionB.messages)[0];
          if (!rawTip) {
            api.logger.warn("[DAILY_RISK_TIPS] no assistant text produced by the generation turn");
            return jsonResult({ success: false, error: "未能从模型输出中获得每日风险提示正文。" });
          }

          return jsonResult({ success: true, daily_risk_tip: stripLayout(rawTip) });
        } catch (error) {
          api.logger.error(`[DAILY_RISK_TIPS] execute failed: ${String(error)}`);
          return jsonResult({ success: false, error: "生成过程中发生错误。" });
        } finally {
          await cleanup();
        }
      },
    };
  };
}
