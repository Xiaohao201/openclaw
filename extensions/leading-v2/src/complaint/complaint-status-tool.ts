import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 20;

const ComplaintTaskStatusSchema = Type.Object(
  {
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
        "只读查询当前账号可见的一键举报任务。省略 taskId 时列出最近任务及真实进度；" +
        "传入 taskId 时返回每条链接的举报提交状态、失败原因和下架复检结果。" +
        "必须以本工具返回的数据为准；没有任务时禁止声称已受理、已入队或 worker 正在执行。" +
        "注意：举报提交 Done 不等于链接已下架，只有 offline=true 才表示已确认下架或失效。",
      parameters: ComplaintTaskStatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "complaint_task_status");
        if ("error" in keyed) {
          return keyed.error;
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
              "请逐条报告 submissionStatus 与 failureReason。Done 仅表示举报提交完成；" +
              "只有 offline=true 才能表述为已确认下架或失效。",
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
              : "请以返回的 taskId、status 和计数字段说明真实进度；如需逐链接结果，请用对应 taskId 再次调用本工具。",
        });
      },
    };
  };
}
