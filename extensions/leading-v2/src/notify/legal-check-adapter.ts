import { asString, envelopeError } from "../client/envelope.js";
import { getJson } from "../client/http-client.js";
import type { BackendConfig } from "../client/types.js";
import type { PendingTask, PollResult } from "./types.js";

/**
 * Poll a 图文/视频违规·不实信息检测 (内容检测) task and, once terminal, build a
 * short summary the agent reads out to the user. Mirrors the legal-check
 * extension's own status poll (GET /ai/fetch-job, workspace=pr), but runs in the
 * background so the user is told the moment it finishes — including when it ends
 * in Stop/Fail, which is exactly the case the user otherwise waits forever for.
 *
 * legal_check_job.status: Pending → Crawling → Running → Summary → Done;异常置 Stop。
 */
export async function pollLegalCheck(
  task: PendingTask,
  apiKey: string,
  config: BackendConfig,
): Promise<PollResult> {
  const res = await getJson(
    config,
    "/ai/fetch-job",
    { id: task.backendId, workspace: "pr", all: 1 },
    apiKey,
  );
  const envErr = envelopeError(res);
  if (envErr) {
    throw new Error(`fetch-job failed: ${envErr}`);
  }

  const job = (res.job as Record<string, unknown> | undefined) ?? {};
  const status = asString(job.status) ?? "";
  const name = task.title ?? "未命名";

  if (status === "Stop") {
    return {
      terminal: true,
      summary:
        `内容检测任务「${name}」已停止（处理过程中出现异常）。` +
        `常见原因：链接无法访问或需要登录、视频过长或解析失败、后端处理异常。` +
        `可以换一条链接重新发起检测。`,
    };
  }
  if (status === "Fail") {
    return { terminal: true, summary: `内容检测任务「${name}」失败了，请稍后重试。` };
  }
  if (status !== "Done") {
    return { terminal: false, summary: "" };
  }

  // Done: surface how many paragraphs were flagged + whether 维权文书 is ready,
  // without dumping the full conclusion (the user can ask for details).
  const detail = (res.detail as Record<string, unknown> | undefined) ?? {};
  const tableData = detail.tableData;
  const paragraphCount = Array.isArray(tableData)
    ? tableData.length
    : tableData && typeof tableData === "object"
      ? Object.keys(tableData).length
      : 0;
  const flagged = paragraphCount > 0 ? `共发现 ${paragraphCount} 处需关注的内容，` : "";
  return {
    terminal: true,
    summary: `内容检测任务「${name}」已完成，${flagged}详细结论可以向我询问或在网页内容检测页查看。`,
  };
}
