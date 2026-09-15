import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";
import { ComplaintBatchStore, type ComplaintBatch } from "./complaint-batch-store.js";

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 20;

const ComplaintTaskStatusSchema = Type.Object(
  {
    batchId: Type.Optional(
      Type.String({
        format: "uuid",
        description:
          "本次 complaint_submit 返回的批次 ID；一次查询该批次全部链接，不受任务列表分页限制。",
      }),
    ),
    listBatches: Type.Optional(
      Type.Boolean({
        description:
          "列出当前用户保存的举报批次，结合链接及时间选择 batchId；可用 page、size 分页。",
      }),
    ),
    taskId: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "举报任务 ID。传入时返回该任务下的逐链接提交及下架状态。",
      }),
    ),
    q: Type.Optional(Type.String({ maxLength: 200, description: "按关联检测任务标签筛选。" })),
    page: Type.Optional(Type.Integer({ minimum: 1, description: "任务列表页码，默认 1。" })),
    size: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        description: `任务列表每页数量，默认 ${DEFAULT_PAGE_SIZE}，最多 ${MAX_PAGE_SIZE}。`,
      }),
    ),
  },
  { additionalProperties: false },
);

type ComplaintState = "pending" | "running" | "done" | "failed" | "stopped" | "unknown";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeState(value: unknown): ComplaintState {
  switch ((asString(value) ?? "").toLowerCase()) {
    case "pending":
      return "pending";
    case "running":
    case "processing":
      return "running";
    case "done":
    case "completed":
    case "success":
      return "done";
    case "fail":
    case "failed":
      return "failed";
    case "stop":
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function parseLinks(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter((item): item is string => Boolean(item));
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => asString(item)).filter((item): item is string => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function normalizeLinkItem(value: unknown) {
  const item = asRecord(value);
  return {
    id: asNumber(item.id),
    link: asString(item.link) ?? "",
    title: asString(item.title) ?? "",
    author: asString(item.author) ?? "",
    platform: asString(item.platform) ?? "",
  };
}

function normalizeTask(value: unknown) {
  const task = asRecord(value);
  return {
    id: asNumber(task.id),
    jobId: asNumber(task.jobId),
    status: asString(task.status) ?? "",
    state: normalizeState(task.status),
    createdAt: asString(task.date) ?? null,
    updatedAt: asString(task.updateDate) ?? null,
    links: parseLinks(task.links),
    reason: asString(task.reason) ?? null,
    linkTotal: asNumber(task.linkTotal),
    doneCount: asNumber(task.doneCount),
    stopCount: asNumber(task.stopCount),
    progressCount: asNumber(task.progressCount),
    offlineCount: asNumber(task.offlineCount),
    linkItems: (Array.isArray(task.linkItems) ? task.linkItems : [])
      .map(normalizeLinkItem)
      .toSorted((left, right) => right.id - left.id),
  };
}

function normalizeStats(value: unknown) {
  const stats = asRecord(value);
  return {
    totalTasks: asNumber(stats.totalTasks),
    doneTasks: asNumber(stats.doneTasks),
    progressTasks: asNumber(stats.progressTasks),
    stoppedTasks: asNumber(stats.stoppedTasks),
    totalLinks: asNumber(stats.totalLinks),
    offlineCount: asNumber(stats.offlineCount),
    doneLinks: asNumber(stats.doneLinks),
    stoppedLinks: asNumber(stats.stoppedLinks),
    platformCount: asNumber(stats.platformCount),
    successRate: asNumber(stats.successRate),
  };
}

function normalizePlatform(value: unknown) {
  const platform = asRecord(value);
  return {
    platform: asString(platform.platform) ?? "",
    total: asNumber(platform.total),
    offline: asNumber(platform.offline),
  };
}

function normalizeComplaint(value: unknown) {
  const complaint = asRecord(value);
  const submissionStatus = asString(complaint.submissionStatus) ?? asString(complaint.status) ?? "";
  return {
    id: asNumber(complaint.id),
    taskId: asNumber(complaint.taskId),
    link: asString(complaint.link) ?? "",
    title: asString(complaint.title) ?? "",
    author: asString(complaint.author) ?? "",
    platform: asString(complaint.platform) ?? "",
    submissionStatus,
    state: normalizeState(submissionStatus),
    failureReason: asString(complaint.failureReason) ?? asString(complaint.memo) ?? null,
    offline: asNumber(complaint.offline) === 1,
    offlineCheckDate: asString(complaint.offlineCheckDate) ?? null,
    updatedAt: asString(complaint.updateDate) ?? null,
    taxonomyVersionId: asNumber(complaint.taxonomyVersionId),
    categoryCode: asString(complaint.categoryCode) ?? null,
    subCategoryCode: asString(complaint.subCategoryCode) ?? null,
    category: asString(complaint.category) ?? null,
    subCategory: asString(complaint.subCategory) ?? null,
  };
}

function responseError(response: Record<string, unknown>): string | null {
  const error = envelopeError(response);
  if (error) {
    return error;
  }
  if (response.code !== undefined && response.code !== "success") {
    return asString(response.message) ?? "Backend returned an error.";
  }
  return null;
}

async function queryBatch(batch: ComplaintBatch, config: BackendConfig, apiKey: string) {
  const taskIds = [
    ...new Set(batch.entries.flatMap((entry) => (entry.taskId === null ? [] : [entry.taskId]))),
  ].toSorted((a, b) => a - b);
  const results = new Map<number, ReturnType<typeof normalizeComplaint>[]>();
  // Bounded parallel reads keep a 100-link batch practical without flooding the backend.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, taskIds.length) }, async () => {
      while (next < taskIds.length) {
        const taskId = taskIds[next++];
        try {
          const response = await getJson(config, `/legal/fetch-complaints/${taskId}`, {}, apiKey);
          if (!responseError(response) && Array.isArray(response.list)) {
            results.set(taskId, response.list.map(normalizeComplaint));
          }
        } catch {
          /* Missing results remain unknown; other tasks can still be reported. */
        }
      }
    }),
  );
  const links = batch.entries.map((entry) => {
    const matches =
      entry.taskId === null
        ? []
        : (results.get(entry.taskId) ?? []).filter(
            (item) => item.taskId === entry.taskId && item.link === entry.link,
          );
    // Never select an arbitrary duplicate or borrow another task's/link's status.
    const complaint = matches.length === 1 ? matches[0] : null;
    const state =
      complaint?.state ??
      (entry.acceptance === "not_attempted"
        ? "not_submitted"
        : entry.acceptance === "rejected" && entry.taskId === null
          ? "failed"
          : "unknown");
    return {
      ...entry,
      state,
      submissionStatus: complaint?.submissionStatus ?? null,
      failureReason: complaint?.failureReason ?? null,
      offline: complaint?.offline ?? null,
      offlineCheckDate: complaint?.offlineCheckDate ?? null,
      queryStatus: complaint
        ? "found"
        : entry.taskId === null
          ? "no_task_id"
          : results.has(entry.taskId)
            ? "missing_or_ambiguous"
            : "query_failed",
    };
  });
  return {
    success: true,
    mode: "batch",
    batchId: batch.batchId,
    createdAt: batch.createdAt,
    summary: {
      total: links.length,
      submitted: links.filter((item) => item.state === "done").length,
      processing: links.filter((item) => item.state === "pending" || item.state === "running")
        .length,
      failed: links.filter((item) => item.state === "failed").length,
      stopped: links.filter((item) => item.state === "stopped").length,
      unknown: links.filter((item) => item.state === "unknown").length,
      notSubmitted: links.filter((item) => item.state === "not_submitted").length,
      offline: links.filter((item) => item.offline === true).length,
    },
    links,
    agentInstruction:
      "这是指定批次的全部链接，按 summary 汇总并按需列出逐链接状态及失败原因。success=true 仅表示完成查询流程，query_failed、missing_or_ambiguous、no_task_id 或 unknown 均无法确认平台提交结果。" +
      "acceptance=accepted 仅表示举报服务已接收；只有 state=done 才表示已提交到平台，不代表平台已受理或处置。只有 offline=true 表示已检测到下架或失效。不得自动重提结果未知或已接收的链接。",
  };
}

/** Read-only view of complaint task progress and per-link platform/takedown status. */
export function createComplaintTaskStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }

    return {
      name: "complaint_task_status",
      label: "查询举报任务状态",
      description:
        "优先传 complaint_submit 返回的 batchId，按当前用户保存的精确任务 ID 一次汇总整批链接；忘记批次 ID 时用 listBatches=true 查本用户批次。" +
        "只读查询当前账号可见的一键举报任务。省略 taskId 时列出最近任务及真实进度；" +
        "传入 taskId 时返回每条链接的举报提交状态、失败原因和下架复检结果。" +
        "complaint_submit 成功只表示举报服务已接收任务；是否已提交到目标平台必须查询本工具的逐链接状态确认。" +
        "必须以本工具返回的数据为准；没有任务时禁止声称已受理、已入队或 worker 正在执行。" +
        "注意：举报提交 Done 不等于链接已下架，只有 offline=true 才表示已确认下架或失效。",
      parameters: ComplaintTaskStatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        if (
          [
            rawParams.batchId !== undefined,
            rawParams.listBatches === true,
            rawParams.taskId !== undefined,
          ].filter(Boolean).length > 1
        ) {
          return jsonResult({
            success: false,
            error: "batchId、listBatches、taskId 只能选择一种查询方式。",
          });
        }
        const keyed = await resolveKeyOrError(api, resolver, userId, "complaint_task_status");
        if ("error" in keyed) {
          return keyed.error;
        }

        if (rawParams.batchId !== undefined || rawParams.listBatches === true) {
          const store = new ComplaintBatchStore(() => api.runtime.state.resolveStateDir());
          try {
            if (rawParams.batchId !== undefined) {
              const batch =
                typeof rawParams.batchId === "string"
                  ? await store.get(userId, rawParams.batchId)
                  : null;
              if (!batch) {
                return jsonResult({
                  success: false,
                  error: "未找到当前用户的举报批次，请核对 batchId 或使用 listBatches 查询。",
                });
              }
              return jsonResult(await queryBatch(batch, config, keyed.apiKey));
            }
            const page = Math.max(1, Math.floor(Number(rawParams.page ?? 1) || 1));
            const size = Math.min(
              MAX_PAGE_SIZE,
              Math.max(
                1,
                Math.floor(Number(rawParams.size ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE),
              ),
            );
            const batches = await store.list(userId);
            return jsonResult({
              success: true,
              mode: "batches",
              total: batches.length,
              page,
              size,
              batches: batches.slice((page - 1) * size, page * size).map((batch) => ({
                batchId: batch.batchId,
                createdAt: batch.createdAt,
                total: batch.entries.length,
                links: batch.entries.map((entry) => entry.link),
              })),
              agentInstruction:
                "根据本次链接和时间选择明确匹配的 batchId，再查询整批状态；不要默认选择最新批次。这里只是批次记录，不是平台提交结果。",
            });
          } catch {
            return jsonResult({
              success: false,
              error: "无法读取举报批次记录，请联系管理员检查存储；不要推断举报状态或重新提交。",
            });
          }
        }

        if (rawParams.taskId !== undefined) {
          const taskId = Number(rawParams.taskId);
          if (!Number.isInteger(taskId) || taskId <= 0) {
            return jsonResult({ success: false, error: "taskId 必须是大于 0 的整数。" });
          }

          let response: Record<string, unknown>;
          try {
            response = await getJson(config, `/legal/fetch-complaints/${taskId}`, {}, keyed.apiKey);
          } catch (error) {
            return failure(api, "complaint_task_status", userId, error);
          }
          const error = responseError(response);
          if (error) {
            return jsonResult({ success: false, error });
          }

          const complaints = (Array.isArray(response.list) ? response.list : [])
            .map(normalizeComplaint)
            .toSorted((left, right) => right.id - left.id);
          const summary = {
            total: complaints.length,
            submitted: complaints.filter((item) => item.state === "done").length,
            stopped: complaints.filter((item) => item.state === "stopped").length,
            failed: complaints.filter((item) => item.state === "failed").length,
            processing: complaints.filter(
              (item) =>
                item.state === "pending" || item.state === "running" || item.state === "unknown",
            ).length,
            offline: complaints.filter((item) => item.offline).length,
          };
          return jsonResult({
            success: true,
            mode: "detail",
            taskId,
            summary,
            complaints,
            agentInstruction:
              "success=true 仅表示查询成功。请逐条报告 submissionStatus 与 failureReason，不能把整批任务接收成功当成平台提交成功。" +
              "Done 仅表示举报已提交到目标平台，不代表平台已受理、认可举报或完成处置；" +
              "pending/running 表示等待或处理中，failed/stopped 表示失败或停止，unknown 表示无法确认，均不得宣称已提交到平台。" +
              "只有 offline=true 才能表述为已确认下架或失效；未查到记录时如实说明无法确认，不要推断正在执行。",
          });
        }

        const page = Math.max(1, Math.floor(Number(rawParams.page ?? 1) || 1));
        const size = Math.min(
          MAX_PAGE_SIZE,
          Math.max(1, Math.floor(Number(rawParams.size ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE)),
        );
        const params: Record<string, FieldValue> = {
          page,
          size,
          q: asString(rawParams.q),
        };
        let response: Record<string, unknown>;
        try {
          response = await getJson(config, "/legal/fetch-complaint-tasks", params, keyed.apiKey);
        } catch (error) {
          return failure(api, "complaint_task_status", userId, error);
        }
        const error = responseError(response);
        if (error) {
          return jsonResult({ success: false, error });
        }

        const tasks = (Array.isArray(response.list) ? response.list : [])
          .map(normalizeTask)
          .toSorted((left, right) => right.id - left.id);
        return jsonResult({
          success: true,
          mode: "list",
          page,
          size,
          total: asNumber(response.total),
          tasks,
          stats: normalizeStats(response.stats),
          platforms: (Array.isArray(response.platformDist) ? response.platformDist : [])
            .map(normalizePlatform)
            .toSorted((left, right) => left.platform.localeCompare(right.platform)),
          agentInstruction:
            tasks.length === 0
              ? "当前可见范围没有举报任务。请如实告知用户尚未查到已提交任务，禁止声称已受理、已入队或 worker 正在执行。"
              : "请以返回任务的 id、status 和计数字段说明真实进度；确认平台提交结果时，必须将匹配任务的 id 作为 taskId 再次查询逐链接状态。" +
                "结合链接和时间核对任务，不要仅因任务最新就认定为本次举报。举报服务接收任务不等于已提交到平台，也不等于链接已下架。",
        });
      },
    };
  };
}
