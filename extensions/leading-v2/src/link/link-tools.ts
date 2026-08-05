import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { RecentTaskStore } from "../client/recent-tasks.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";
import { getChatMercureTopic } from "../notify/chat-topic.js";
import type { PendingTaskRegistry } from "../notify/pending-store.js";
import type { NotifyConfig, NotifyToolContext } from "../notify/types.js";
import {
  linkStatusJobPath,
  linkStatusResultsPath,
  mapStatusRow,
  STATUS_LABELS,
  type LinkStatusRow,
} from "./link-status.js";

/**
 * What we remember per user so link_batch_status can poll without exposing the
 * job id. The 失效链接检测 backend (LinkController / link_status_job) keys every
 * read by the numeric job id, so that is what we keep.
 */
export interface RecentLinkBatch {
  jobId: number;
  label: string | null;
}

const MAX_LINKS = 1000;
/** Cap on how many per-link rows we hand the model, worst-first. */
const MAX_ROWS_RETURNED = 200;

const CreateSchema = Type.Object(
  {
    links: Type.Union([Type.Array(Type.String()), Type.String()], {
      description:
        "The links to check for dead/失效 status. Either an array of URLs or a newline-separated string. " +
        `Duplicates are removed. Max ${MAX_LINKS} links per task.`,
    }),
    label: Type.String({
      description: "A short task name for this batch (失效链接检测任务名), max 255 chars.",
    }),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    label: Type.Optional(
      Type.String({
        description:
          "Optional. The task name to look up when the user asks about an older 失效链接检测 task. " +
          "Leave unset to poll the most recent task of this account.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ListSchema = Type.Object(
  {
    page: Type.Optional(Type.Number({ description: "1-based page number. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size, 1-50. Default 10." })),
    q: Type.Optional(Type.String({ description: "Optional keyword to match the task name." })),
  },
  { additionalProperties: false },
);

function normalizeLinks(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map((x) => String(x).trim())
    : typeof raw === "string"
      ? raw.split(/\r?\n/).map((x) => x.trim())
      : [];
  const valid = list.filter((u) => /^https?:\/\//i.test(u));
  return [...new Set(valid)];
}

/** Worst-first so the truncation cap never drops a dead link in favor of a healthy one. */
const VERDICT_RANK: Record<string, number> = { invalid: 0, unknown: 1, valid: 2 };

function summarizeRows(rows: LinkStatusRow[]): {
  list: LinkStatusRow[];
  truncated: number;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  }
  const sorted = rows.toSorted(
    (a, b) => (VERDICT_RANK[a.verdict] ?? 9) - (VERDICT_RANK[b.verdict] ?? 9),
  );
  return {
    list: sorted.slice(0, MAX_ROWS_RETURNED),
    truncated: Math.max(0, sorted.length - MAX_ROWS_RETURNED),
    counts,
  };
}

export function createLinkBatchCreateToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentLinkBatch>,
  registry: PendingTaskRegistry,
  notify: NotifyConfig,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: NotifyToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "link_batch_create",
      label: "Create Link Batch Check",
      description:
        "Submit a batch of links for 失效链接检测 (the same engine and task list as the web 失效链接检测). " +
        "Each link is opened by the backend crawler and judged 失效/正常, with a reason when it could not be judged. " +
        "The task shows up in the user's 失效链接检测任务列表 on the web console. " +
        "Detection runs asynchronously — call link_batch_status to poll progress and per-link results. " +
        "The task is tracked server-side; never mention any internal task id to the user.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "link_batch_create");
        if ("error" in keyed) {
          return keyed.error;
        }
        const links = normalizeLinks(rawParams.links);
        if (links.length === 0) {
          return jsonResult({
            success: false,
            error: "links is required (one or more http(s) URLs).",
          });
        }
        if (links.length > MAX_LINKS) {
          return jsonResult({
            success: false,
            error: `Too many links (max ${MAX_LINKS} per task); split into multiple batches.`,
          });
        }
        const label = asString(rawParams.label);
        if (!label) {
          return jsonResult({ success: false, error: "label is required (a short task name)." });
        }

        // The backend expects `data[]` rows as JSON strings ({link,title,platform}),
        // matching the web uploader's payload; `fileUrl` is the optional source file.
        const fields: Record<string, FieldValue> = {
          label: label.slice(0, 255),
          data: links.map((link) => JSON.stringify({ link })),
          fileUrl: "",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/link/submit-offline-check-links", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "link_batch_create", userId, error);
        }

        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const jobId = Number(res.id ?? 0);
        if (!Number.isFinite(jobId) || jobId <= 0) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        store.remember(userId, { jobId, label });

        // Register for background completion notification (same flow as
        // 互动量刷新): the CompletionNotifier polls this task and pushes the
        // result summary when it finishes, so the user need not keep asking.
        const sessionKey =
          ctx.sessionKey ??
          (ctx.sessionId
            ? `agent:rabbitmq-${userId}:rabbitmq:${userId}:${ctx.sessionId}`
            : undefined);
        const willNotify = notify.enabled && Boolean(sessionKey);
        if (willNotify && sessionKey) {
          const now = Date.now();
          registry.add({
            id: `link_check:${jobId}`,
            kind: "link_check",
            uid: userId,
            backendId: String(jobId),
            sessionKey,
            mercureTopic: getChatMercureTopic(userId) ?? userId,
            delivery: ctx.deliveryContext ?? {},
            title: label,
            createdAt: now,
            attempts: 0,
            notified: false,
            expiresAt: now + notify.ttlMs,
          });
        }

        return jsonResult({
          success: true,
          submitted: true,
          label,
          linkCount: links.length,
          message: asString(res.message) ?? "链接提交成功",
          agentInstruction: willNotify
            ? "失效链接检测任务已提交成功，任务已出现在用户的失效链接检测任务列表中。" +
              "任务在后台逐条检测，通常需要数分钟。" +
              "完成后系统会自动通知用户，无需用户追问、也不要调用状态查询工具——你现在只需告诉用户「任务已提交，检测完会自动告诉你」。"
            : "失效链接检测任务已提交成功，任务已出现在用户的失效链接检测任务列表中。" +
              "请立刻告知用户任务正在后台逐条检测，通常需要数分钟。" +
              "不要调用任何状态查询工具——等用户主动询问进度时再用 link_batch_status 查询。",
        });
      },
    };
  };
}

/** Resolve the job id to poll: an explicit task name, else this account's most recent task. */
async function resolveJobId(
  config: BackendConfig,
  apiKey: string,
  store: RecentTaskStore<RecentLinkBatch>,
  userId: string,
  label: string | undefined,
): Promise<{ jobId: number; label: string | null } | { error: string }> {
  if (!label) {
    const recent = store.latest(userId);
    if (!recent) {
      return { error: "No recent link check to poll; create one with link_batch_create first." };
    }
    return { jobId: recent.jobId, label: recent.label };
  }
  const res = await getJson(
    config,
    "/link/fetch-link-status-jobs",
    { page: 1, size: 20, q: label },
    apiKey,
  );
  const err = envelopeError(res);
  if (err) {
    return { error: err };
  }
  const rows = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
  const hit = rows.find((r) => asString(r.label) === label) ?? rows[0];
  if (!hit) {
    return { error: `没有找到名为「${label}」的失效链接检测任务。` };
  }
  return { jobId: Number(hit.id), label: asString(hit.label) ?? label };
}

export function createLinkBatchStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentLinkBatch>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "link_batch_status",
      label: "Link Batch Status",
      description:
        "Get the progress and per-link results of a 失效链接检测 batch (the most recent one unless a task name is given). " +
        "Returns each link's verdict (失效/正常/无法判定) with the判定依据 once available. " +
        "⚠️ SINGLE-USE PER TURN: call this tool EXACTLY ONCE per user request, then immediately " +
        "reply to the user with the result — regardless of whether the task is done. " +
        "NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "link_batch_status");
        if ("error" in keyed) {
          return keyed.error;
        }
        let resolved: Awaited<ReturnType<typeof resolveJobId>>;
        try {
          resolved = await resolveJobId(
            config,
            keyed.apiKey,
            store,
            userId,
            asString(rawParams.label),
          );
        } catch (error) {
          return failure(api, "link_batch_status", userId, error);
        }
        if ("error" in resolved) {
          return jsonResult({ success: false, error: resolved.error });
        }
        const { jobId } = resolved;

        let detail: Record<string, unknown>;
        try {
          detail = await getJson(config, linkStatusJobPath(jobId), {}, keyed.apiKey);
        } catch (error) {
          return failure(api, "link_batch_status", userId, error);
        }
        const detailErr = envelopeError(detail);
        if (detailErr) {
          return jsonResult({ success: false, error: detailErr });
        }
        const job = (detail.job as Record<string, unknown> | undefined) ?? {};
        const status = (asString(job.status) ?? "").toLowerCase();
        const done = status === "done";
        const stopped = status === "stop";
        const terminal = done || stopped;
        const linksTotal = Number(job.linksTotal ?? 0);
        const checkedTotal = Number(job.checkedTotal ?? 0);
        const offlineTotal = Number(job.offlineTotal ?? 0);

        // Per-link verdicts: available as soon as the worker has checked anything,
        // so fetch unless the task has not started.
        let rows: LinkStatusRow[] = [];
        if (checkedTotal > 0) {
          let records: Record<string, unknown>;
          try {
            records = await getJson(config, linkStatusResultsPath(jobId), {}, keyed.apiKey);
          } catch (error) {
            return failure(api, "link_batch_status", userId, error);
          }
          const recordsErr = envelopeError(records);
          if (recordsErr) {
            return jsonResult({ success: false, error: recordsErr });
          }
          const raw = Array.isArray(records.list)
            ? (records.list as Record<string, unknown>[])
            : [];
          rows = raw.map(mapStatusRow);
        }
        const { list, truncated, counts } = summarizeRows(rows);

        return jsonResult({
          success: true,
          status,
          statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
          ...(terminal ? { done, stopped } : {}),
          label: resolved.label,
          linksTotal,
          checkedTotal,
          offlineTotal,
          validTotal: counts.valid ?? 0,
          unknownTotal: counts.unknown ?? 0,
          total: rows.length,
          list,
          ...(truncated > 0 ? { truncated } : {}),
          agentInstruction: terminal
            ? "检测已结束，请向用户展示每条链接的判定结果。失效/无法判定的链接如实说明判定依据，不要编造。" +
              (truncated > 0 ? `另有 ${truncated} 条正常链接未在此列出，只汇报数量即可。` : "")
            : "⚠️ 检测仍在进行中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。",
        });
      },
    };
  };
}

export function createLinkBatchListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "link_batch_list",
      label: "List Link Batch Checks",
      description:
        "List this account's 失效链接检测 tasks (the same 任务列表 as the web console), newest first. " +
        "Use it when the user asks what link checks exist or how an earlier task turned out; " +
        "then call link_batch_status with that task's name for its per-link results.",
      parameters: ListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "link_batch_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const page = Math.max(1, Number(rawParams.page ?? 1) || 1);
        const size = Math.min(50, Math.max(1, Number(rawParams.size ?? 10) || 10));
        const q = asString(rawParams.q);

        let res: Record<string, unknown>;
        try {
          res = await getJson(
            config,
            "/link/fetch-link-status-jobs",
            { page, size, ...(q ? { q } : {}) },
            keyed.apiKey,
          );
        } catch (error) {
          return failure(api, "link_batch_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const rows = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
        const list = rows.map((r) => {
          const status = (asString(r.status) ?? "").toLowerCase();
          return {
            label: asString(r.label) ?? null,
            status,
            statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
            linksTotal: Number(r.linksTotal ?? 0),
            createdAt: asString(r.date) ?? null,
            updatedAt: asString(r.updateDate) ?? null,
            reportUrl: asString(r.file) ?? null,
          };
        });

        return jsonResult({
          success: true,
          page,
          size,
          total: Number(res.total ?? list.length),
          list,
          agentInstruction:
            "这是用户的失效链接检测任务列表。用任务名称称呼任务，不要提及任何内部 id。" +
            "需要某个任务的逐条结果时，用 link_batch_status 并传入该任务名称。",
        });
      },
    };
  };
}
