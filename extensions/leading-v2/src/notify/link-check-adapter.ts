import { asString, envelopeError } from "../client/envelope.js";
import { getJson } from "../client/http-client.js";
import type { BackendConfig } from "../client/types.js";
import {
  isTerminalStatus,
  linkStatusJobPath,
  linkStatusResultsPath,
  mapStatusRow,
  VERDICT_LABELS,
} from "../link/link-status.js";
import type { PendingTask, PollResult } from "./types.js";

/**
 * Poll a 失效链接检测 task: GET the job for its status, and when it finishes GET
 * fetch-link-status-results to build a short summary the agent can read out.
 * Mirrors pollCrawlRefresh; the job is keyed by the numeric link_status_job id.
 */
export async function pollLinkCheck(
  task: PendingTask,
  apiKey: string,
  config: BackendConfig,
): Promise<PollResult> {
  const jobId = Number(task.backendId);
  const detail = await getJson(config, linkStatusJobPath(jobId), {}, apiKey);
  const detailErr = envelopeError(detail);
  if (detailErr) {
    throw new Error(`fetch-link-status-job failed: ${detailErr}`);
  }
  const job = (detail.job as Record<string, unknown> | undefined) ?? {};
  const status = (asString(job.status) ?? "").toLowerCase();

  if (!isTerminalStatus(status)) {
    return { terminal: false, summary: "" };
  }
  if (status === "stop") {
    return { terminal: true, summary: `失效链接检测任务「${task.title ?? "未命名"}」已停止。` };
  }

  const records = await getJson(config, linkStatusResultsPath(jobId), {}, apiKey);
  const recordsErr = envelopeError(records);
  if (recordsErr) {
    throw new Error(`fetch-link-status-results failed: ${recordsErr}`);
  }
  const raw = Array.isArray(records.list) ? (records.list as Record<string, unknown>[]) : [];
  const rows = raw.map(mapStatusRow);
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  }
  // Lead with the actionable count (失效), then the rest in a stable order.
  const order = ["invalid", "unknown", "valid"];
  const breakdown = order
    .filter((v) => counts[v])
    .map((v) => `${VERDICT_LABELS[v] ?? v} ${counts[v]}`)
    .join("、");
  const invalidRows = rows.filter((r) => r.verdict === "invalid");
  const invalidLines = invalidRows.slice(0, 10).map((r) => `- ${r.url ?? ""}（失效）`);
  const moreInvalid =
    invalidRows.length > 10 ? `\n（失效共 ${invalidRows.length} 条，仅列前 10 条）` : "";
  const detailBlock =
    invalidLines.length > 0 ? `\n失效链接：\n${invalidLines.join("\n")}${moreInvalid}` : "";

  const summary =
    `失效链接检测任务「${task.title ?? "未命名"}」已完成，共 ${rows.length} 条：` +
    `${breakdown || "无结果"}。${detailBlock}`;
  return { terminal: true, summary };
}
