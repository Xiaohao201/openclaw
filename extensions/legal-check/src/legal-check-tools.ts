import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { extractUrl } from "./extract-url.js";
import { getJson, LegalApiError, postForm, resolveConfig } from "./http-client.js";
import { ApiKeyResolver } from "./key-resolver.js";
import { RecentJobStore } from "./recent-jobs.js";
import type { LegalApiConfig } from "./types.js";

/** Chat agents are named `rabbitmq-<userId>`; that userId is the trusted identity. */
const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;

function extractUserId(agentId: string | undefined): string | null {
  const match = RABBITMQ_AGENT_PATTERN.exec(agentId ?? "");
  return match?.[1] ?? null;
}

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const CreateSchema = Type.Object(
  {
    content: Type.String({
      description:
        "The 图文/视频 to check: a public URL, OR the pasted title+text. If it contains a URL " +
        "the backend crawls it; otherwise it analyzes the pasted text. (Web 上传视频 is not supported here.)",
    }),
    mode: Type.Optional(
      stringEnum(
        ["violation", "rumor"] as const,
        '"violation" (违规检测, default) flags illegal/non-compliant content; ' +
          '"rumor" (不实信息检测) checks against a known truth you provide.',
      ),
    ),
    target: Type.Optional(
      Type.String({ description: "维权主体 (the aggrieved party). Optional." }),
    ),
    truth: Type.Optional(
      Type.String({
        description:
          'rumor mode only: the verified truth ("真相详情"). Required when mode="rumor".',
      }),
    ),
    verifiedBy: Type.Optional(
      Type.String({
        description:
          'rumor mode only: the unit that verified the truth ("核实单位"). Required when mode="rumor".',
      }),
    ),
    gov: Type.Optional(
      Type.Boolean({ description: "Also prepare the government-report letter. Default false." }),
    ),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    jobId: Type.Optional(
      Type.Number({
        description:
          "Internal — leave unset. The tool polls the most recent check for this account on its own.",
      }),
    ),
  },
  { additionalProperties: false },
);

const STATUS_LABELS: Record<string, string> = {
  Pending: "排队中",
  Running: "检测中",
  Summary: "生成报告中",
  Done: "已完成",
  Fail: "失败",
  Stop: "已停止",
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Map a backend error/login envelope to a tool error, or null when it looks OK. */
function envelopeError(res: Record<string, unknown>): string | null {
  if (res.login) {
    return "Backend rejected the request (not authorized for this account).";
  }
  if (res.code === "danger") {
    return asString(res.message) ?? "Backend returned an error.";
  }
  return null;
}

/** Tool ctx for the create tool: agentId plus the delivery addressing captured
 * at submit time (needed to register for proactive completion notification). */
interface CreateToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  deliveryContext?: Record<string, unknown>;
}

/** Descriptor handed to leading-v2's enqueue hook. Mirrors its NotifyEnqueueInput;
 * kept local because the plugin boundary forbids importing across extensions. */
interface ProactiveNotifyInput {
  kind: "legal_check";
  uid: string;
  backendId: string;
  sessionKey: string;
  title?: string | null;
  delivery?: Record<string, unknown>;
}

/**
 * Register a 内容检测 job with leading-v2's CompletionNotifier so it proactively
 * reports the result (including Stop/Fail) to the user's chat when done. Reaches
 * the hook via the same process-wide Symbol.for contract chat-topic.ts uses — no
 * cross-extension import. Returns false (→ poll-only fallback) when leading-v2 is
 * absent or notify is disabled, i.e. when the hook was never installed.
 */
function enqueueProactiveNotify(input: ProactiveNotifyInput): boolean {
  const sym = Symbol.for("openclaw.leading-v2.notifyEnqueue");
  const g = globalThis as unknown as Record<
    symbol,
    ((i: ProactiveNotifyInput) => boolean) | undefined
  >;
  const fn = g[sym];
  if (typeof fn !== "function") {
    return false;
  }
  try {
    return fn(input) === true;
  } catch {
    return false;
  }
}

export function createLegalCheckCreateToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentJobStore,
) {
  const config = resolveConfig(api.pluginConfig ?? {});

  return (ctx: CreateToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    // Same session-key derivation as leading-v2's notify-aware tools: prefer the
    // explicit key, else synthesize the rabbitmq agent session address.
    const sessionKey =
      ctx.sessionKey ??
      (ctx.sessionId ? `agent:rabbitmq-${userId}:rabbitmq:${userId}:${ctx.sessionId}` : undefined);

    return {
      name: "legal_check_create",
      label: "Create Legal Check",
      description:
        "Create a 图文/视频违规检测 or 不实信息检测 task (the same engine as the web 内容检测 page). " +
        "The analysis runs asynchronously — call legal_check_status (no arguments) to poll the result. " +
        "Each check consumes the account's legal-check credit. " +
        "The job is tracked server-side; never mention any internal job id or number to the user.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        let apiKey: string;
        try {
          apiKey = await resolver.getApiKey(userId);
        } catch (error) {
          api.logger.error(
            `[LEGAL_CHECK_CREATE] key resolution failed for ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error:
              "Could not resolve an API key for this account; ask the operator to check legal-check config.",
          });
        }
        const content = asString(rawParams.content);
        if (!content) {
          return jsonResult({
            success: false,
            error: "content is required (a URL or the text to check).",
          });
        }
        const mode = rawParams.mode === "rumor" ? "rumor" : "violation";
        if (mode === "rumor") {
          if (!asString(rawParams.truth) || !asString(rawParams.verifiedBy)) {
            return jsonResult({
              success: false,
              error: 'mode="rumor" requires both truth (真相详情) and verifiedBy (核实单位).',
            });
          }
        }

        const fields: Record<string, string | number | undefined> = {
          requirement: content,
          link: extractUrl(content),
          upload: 0,
          rumor: mode === "rumor" ? 1 : 0,
          target: asString(rawParams.target) ?? "",
          data: asString(rawParams.truth) ?? "",
          officialUnit: asString(rawParams.verifiedBy) ?? "",
          gov: rawParams.gov ? 1 : 0,
          regular: 1,
          clientIp: "127.0.0.1",
          siteId: "legal",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/legal/save-job", fields, apiKey);
        } catch (error) {
          return failure(api, "legal_check_create", userId, error);
        }

        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }

        const job = (res.job as Record<string, unknown> | undefined) ?? undefined;
        const jobId = Number(job?.id);
        if (!Number.isInteger(jobId) || jobId <= 0) {
          return jsonResult({ success: false, error: "Backend did not return a job id." });
        }
        const label = asString(job?.label) ?? null;
        // Keep the id server-side only; legal_check_status polls it back.
        store.remember(userId, { jobId, label, mode });

        // Register for background completion notification so the result (or a
        // Stop/Fail) is proactively delivered to the user's chat — they no longer
        // have to keep asking. Skip duplicates (an already-existing job may be
        // long done) and skip when no session/leading-v2 hook is available.
        const duplicated = Boolean(res.duplicated);
        const willNotify =
          !duplicated &&
          Boolean(sessionKey) &&
          enqueueProactiveNotify({
            kind: "legal_check",
            uid: userId,
            backendId: String(jobId),
            sessionKey: sessionKey as string,
            // No title: at submit the backend label is just the URL/text
            // truncated to 80 chars, so a clean "内容检测完成" heading + the full
            // job.link in the polled summary reads better than a broken URL.
            title: null,
            delivery: ctx.deliveryContext,
          });

        // Three cases steer the agent very differently. Duplicate is the trap:
        // the backend dedupes by link (findExistedJobByLink), so re-checking the
        // SAME link returns the existing job (often already Done) WITHOUT creating
        // a new task — telling the user "正在检测" would be a lie, so fetch and
        // show the existing result instead.
        const agentInstruction = duplicated
          ? "这条内容之前已经检测过了（系统按链接去重，本次未新建任务、未消耗额度）。" +
            "切勿说「已提交」或「正在检测」。请立即调用 legal_check_status 取回这条内容的既有检测结果并展示给用户；" +
            "若结果显示仍在进行中，再如实告知当前进度。"
          : willNotify
            ? "内容检测任务已提交成功，后台正在检测，通常需要数分钟。完成后系统会自动把结果通知用户，" +
              "无需用户追问，也不要调用 legal_check_status——你现在只需告诉用户" +
              "「检测任务已提交，检测完成后我会第一时间把结果发给你」。"
            : "内容检测任务已提交成功，后台正在检测中。请如实告知用户任务已提交，并让用户稍后主动问我进度、" +
              "或到网页内容检测页查看——不要承诺会主动通知。不要现在就调用 legal_check_status。";

        return jsonResult({
          success: true,
          submitted: !duplicated,
          duplicated,
          label,
          mode,
          detailPath: `/business/content/${jobId}`,
          agentInstruction,
        });
      },
    };
  };
}

export function createLegalCheckStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentJobStore,
) {
  const config = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }

    return {
      name: "legal_check_status",
      label: "Legal Check Status",
      description:
        "Get the status and result of the most recent 违规/不实信息检测. Call with no arguments. " +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE per user request, then immediately reply to the user — " +
        "regardless of whether the check is done. NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        let apiKey: string;
        try {
          apiKey = await resolver.getApiKey(userId);
        } catch (error) {
          api.logger.error(
            `[LEGAL_CHECK_STATUS] key resolution failed for ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error:
              "Could not resolve an API key for this account; ask the operator to check legal-check config.",
          });
        }
        // The agent never holds the id; default to the latest job we created.
        const jobId =
          rawParams.jobId != null ? Number(rawParams.jobId) : (store.latest(userId)?.jobId ?? 0);
        if (!Number.isInteger(jobId) || jobId <= 0) {
          return jsonResult({
            success: false,
            error: "No recent check to poll; create one with legal_check_create first.",
          });
        }

        let res: Record<string, unknown>;
        try {
          res = await getJson(
            config,
            "/ai/fetch-job",
            { id: jobId, workspace: "pr", all: 1 },
            apiKey,
          );
        } catch (error) {
          return failure(api, "legal_check_status", userId, error);
        }

        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }

        return jsonResult(summarizeJob(jobId, res));
      },
    };
  };
}

function summarizeJob(jobId: number, res: Record<string, unknown>): Record<string, unknown> {
  const job = (res.job as Record<string, unknown> | undefined) ?? {};
  const detail = (res.detail as Record<string, unknown> | undefined) ?? {};
  const status = asString(job.status) ?? "";
  const letterMap = (res.letterMap as Record<string, unknown> | undefined) ?? {};
  const tableData = detail.tableData;
  const paragraphCount = Array.isArray(tableData)
    ? tableData.length
    : tableData && typeof tableData === "object"
      ? Object.keys(tableData).length
      : 0;

  const done = status === "Done";
  const failed = status === "Fail";
  const stopped = status === "Stop";
  const terminal = done || failed || stopped;

  return {
    success: true,
    status,
    statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
    ...(terminal ? { done, failed, stopped } : {}),
    label: asString(job.label) ?? null,
    // The complete submitted URL (job.label is truncated to 80 chars; never use
    // it as the link). Lets the agent show/quote the full link.
    sourceLink: asString(job.link) ?? null,
    mode: Number(job.rumor) === 1 ? "rumor" : "violation",
    target: asString(job.target) ?? null,
    result: detail.result ?? null,
    paragraphCount,
    letters: Object.keys(letterMap),
    detailPath: `/business/content/${jobId}`,
    agentInstruction: terminalInstruction(done, failed, stopped),
  };
}

/** Steer the agent after a terminal/in-progress check; proactively offer next steps on success. */
function terminalInstruction(done: boolean, failed: boolean, stopped: boolean): string {
  if (done) {
    return (
      "检测已完成，请向用户展示检测结果。若发现侵权/违规内容，请主动询问用户是否需要进一步处理：" +
      "① 一键举报（complaint_submit）——把侵权链接按平台提交投诉，并持续监测链接是否下架；" +
      "② 生成维权文书（letter_generate）——撤稿函/举报信/投诉信等。" +
      "用户明确同意后再调用对应工具，不要擅自提交。"
    );
  }
  if (failed) {
    return "检测失败，请如实告知用户，并建议稍后重试。";
  }
  if (stopped) {
    return "检测已停止，请如实告知用户。";
  }
  return "⚠️ 检测仍在进行中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。";
}

function failure(api: OpenClawPluginApi, tool: string, userId: string, error: unknown) {
  if (error instanceof LegalApiError) {
    api.logger.warn(`[${tool.toUpperCase()}] backend error for ${userId}: ${error.message}`);
    return jsonResult({ success: false, error: `Backend request failed: ${error.message}` });
  }
  api.logger.error(`[${tool.toUpperCase()}] failed for ${userId}: ${String(error)}`);
  return jsonResult({ success: false, error: "Request to the backend failed; see gateway logs." });
}

export type { LegalApiConfig };
