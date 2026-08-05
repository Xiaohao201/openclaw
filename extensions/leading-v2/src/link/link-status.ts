import { asString } from "../client/envelope.js";

/**
 * Shared shapes for 失效链接检测 (LinkController / link_status_job + link_status).
 * Both the tools and the completion-notifier adapter read the same two endpoints,
 * so the paths and the row mapping live here to keep them from drifting apart.
 */

/** link_status_job.status — the backend JobStatus enum, lowercased. */
export const STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "检测中",
  summary: "生成报告中",
  done: "已完成",
  stop: "已停止",
  fail: "失败重试中",
};

/** Derived per-link verdicts (the backend stores offline + memo, not a verdict). */
export const VERDICT_LABELS: Record<string, string> = {
  invalid: "失效",
  valid: "正常",
  unknown: "无法判定",
};

export interface LinkStatusRow {
  url: string | null;
  verdict: "invalid" | "valid" | "unknown";
  verdictLabel: string;
  reason: string | null;
}

export function linkStatusJobPath(jobId: number): string {
  return `/link/fetch-link-status-job/${jobId}`;
}

export function linkStatusResultsPath(jobId: number): string {
  return `/link/fetch-link-status-results/${jobId}`;
}

/**
 * Map one `link_status` row to a verdict. The Java OfflineLinksChecker writes
 * `offline=1` for a dead link, and leaves `offline=0` with a Chinese `memo`
 * (验证码 / 页面无法打开 / 登录问题 …) when it could not reach a conclusion.
 */
export function mapStatusRow(row: Record<string, unknown>): LinkStatusRow {
  const offline = Number(row.offline ?? 0) === 1;
  const memo = asString(row.memo);
  const verdict = offline ? "invalid" : memo ? "unknown" : "valid";
  return {
    url: asString(row.link) ?? null,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    reason: memo ?? null,
  };
}

/** A task is over once the backend marks it Done or Stop (Fail means "retrying"). */
export function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "stop";
}
