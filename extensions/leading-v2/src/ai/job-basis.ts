/**
 * 内容检测任务的读取与「维权文书」生成前置。
 *
 * 文书（撤稿函/投诉通知/举报信）的违规事实必须来自检测结果本身——网页端
 * `Letter.vue` 走的就是 `JobResult.collectErrors()`，检测没跑完或违规率为 0
 * 时按钮直接报「未检测到违规事实，无法生成撤稿函」。这里复刻同一套闸门，
 * 免得模型在检测未完成时自行编造违规事实去调后端。
 *
 * 注意：官方公函(GovOfficial)/个人公函(GovPersonal) 不是文书，它们在网页端
 * 分别对应「投诉」与「举报」两个功能（对应工具 infringe_complaint_submit /
 * complaint_submit），因此不列入 LETTER_LABELS。
 */
import { asString } from "../client/envelope.js";
import { getJson } from "../client/http-client.js";
import type { BackendConfig } from "../client/types.js";

export const DEFAULT_WORKSPACE = "pr";

export const JOB_STATUS_LABELS: Record<string, string> = {
  Pending: "处理中",
  Crawling: "抓取中",
  Screenshot: "截图中",
  Running: "检测中",
  Summary: "生成评估报告中",
  Fail: "检测失败",
  Done: "已完成",
  Stop: "已停止",
};

/** 真正的「维权文书」只有这三种。 */
export const LETTER_LABELS: Record<string, string> = {
  Retraction: "撤稿函",
  Complaint: "投诉通知",
  Report: "举报信",
};

/** 检测结果里能取到违规事实的最短长度（与网页端、后端一致）。 */
const MIN_ERRORS_LENGTH = 20;

/** Resolve the most recent pr-workspace job for this account (the one just created in chat). */
export async function resolveLatestJob(
  config: BackendConfig,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const res = await getJson(
    config,
    "/ai/fetch-jobs",
    { workspace: DEFAULT_WORKSPACE, page: 1, size: 1 },
    apiKey,
  );
  const jobs = Array.isArray(res.jobs) ? (res.jobs as Record<string, unknown>[]) : [];
  const job = jobs[0];
  return job && typeof job === "object" ? job : null;
}

/** Resolve the most recent pr-workspace job id for this account (the one just created in chat). */
export async function resolveLatestJobId(
  config: BackendConfig,
  apiKey: string,
): Promise<number | null> {
  const job = await resolveLatestJob(config, apiKey);
  const id = Number(job?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 事实审条目的 problem 是 JSON 字符串，取其中的 reason。 */
function parseSearchProblemReason(problem: string | undefined): string | null {
  if (!problem) {
    return null;
  }
  try {
    const parsed = JSON.parse(problem) as Record<string, unknown>;
    return asString(parsed?.reason) ?? null;
  } catch {
    return null;
  }
}

function collectSearchErrors(searchMap: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const value of Object.values(searchMap)) {
    const search = (value as Record<string, unknown> | undefined) ?? {};
    if (search.insult) {
      const reason = parseSearchProblemReason(asString(search.problem));
      if (reason) {
        lines.push(reason);
      }
      continue;
    }
    if (!search.illegal) {
      continue;
    }
    const result = asString(search.result);
    if (result) {
      lines.push(result);
    }
  }
  return lines;
}

function collectTaskErrors(tasks: Record<string, unknown>[]): string[] {
  const lines: string[] = [];
  for (const task of tasks) {
    const result = asString(task.result);
    if (!result) {
      continue;
    }
    const ruleTitle = asString(task.ruleTitle);
    lines.push(ruleTitle ? `《${ruleTitle}》：${result}` : result);
  }
  return lines;
}

/**
 * 复刻网页端 `JobResult.collectErrors()`：违规率为 0 时返回空串，否则是
 * 评估摘要 + 各违规条目。事实审(search)任务走 searchMap，普通检测走 tasks。
 */
export function collectJobErrors(detail: Record<string, unknown>): string {
  const job = (detail.job as Record<string, unknown> | undefined) ?? {};
  if (!(Number(job.rate ?? 0) > 0)) {
    return "";
  }
  const lines: string[] = [];
  const summary = asString(job.summary);
  if (summary) {
    lines.push(summary);
  }
  if (job.search) {
    const searchMap = (detail.searchMap as Record<string, unknown> | undefined) ?? {};
    lines.push(...collectSearchErrors(searchMap));
  } else {
    const tasks = Array.isArray(detail.tasks) ? (detail.tasks as Record<string, unknown>[]) : [];
    lines.push(...collectTaskErrors(tasks));
  }
  return lines.join("\n").trim();
}

export type LetterBasis =
  | { ok: true; jobId: number; jobLabel: string | null; errors: string }
  | { ok: false; error: string };

function unfinishedJobError(job: Record<string, unknown>): string {
  const status = asString(job.status) ?? "";
  const statusLabel = JOB_STATUS_LABELS[status] ?? status ?? "未知";
  const label = asString(job.label) ?? "";
  const target = label ? `「${label}」` : "";
  if (status === "Stop" || status === "Fail") {
    return (
      `最近一次内容检测任务${target}${statusLabel}，没有完整的检测结果，无法生成文书。` +
      "请告知用户重新发起一次内容检测。"
    );
  }
  return (
    `最近一次内容检测任务${target}尚未完成（当前${statusLabel}）。` +
    "文书必须依据检测结果生成——请告知用户等检测完成后再来生成文书，" +
    "不要自行编写违规事实，也不要在本轮重复调用本工具。"
  );
}

/**
 * 文书生成前置：定位最近一次检测任务 → 必须已完成 → 从检测结果收集违规事实。
 * 任一闸门不过就返回可直接回给模型的中文原因。
 */
export async function resolveLetterBasis(
  config: BackendConfig,
  apiKey: string,
): Promise<LetterBasis> {
  const job = await resolveLatestJob(config, apiKey);
  const jobId = Number(job?.id);
  if (!job || !Number.isInteger(jobId) || jobId <= 0) {
    return { ok: false, error: "没有可生成文书的内容检测任务；请先完成一次内容检测。" };
  }
  if (asString(job.status) !== "Done") {
    return { ok: false, error: unfinishedJobError(job) };
  }

  const detail = await getJson(
    config,
    "/ai/fetch-job",
    { id: jobId, workspace: DEFAULT_WORKSPACE, all: 1 },
    apiKey,
  );
  const errors = collectJobErrors(detail);
  if (errors.length < MIN_ERRORS_LENGTH) {
    return {
      ok: false,
      error:
        "该检测任务未检测到违规事实（违规率为 0 或没有违规条目），无法生成文书。" +
        "请如实告知用户：没有违规事实就生成不了撤稿函/投诉通知/举报信。",
    };
  }
  return { ok: true, jobId, jobLabel: asString(job.label) ?? null, errors };
}
