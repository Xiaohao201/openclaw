import { asString, envelopeError } from "../client/envelope.js";
import { postForm, type FieldValue } from "../client/http-client.js";
import type { BackendConfig } from "../client/types.js";
import { ComplaintBatchStore, type ComplaintBatch } from "./complaint-batch-store.js";

export function batchReferences(batch: ComplaintBatch) {
  return {
    batchId: batch.batchId,
    taskRefs: batch.entries.map(({ link, taskId, acceptance }) => ({ link, taskId, acceptance })),
  };
}

/** Persist before and after each request so interruptions never imply safe automatic retries. */
export async function submitComplaintBatch(params: {
  store: ComplaintBatchStore;
  userId: string;
  config: BackendConfig;
  apiKey: string;
  links: string[];
  requests: Array<{ links: string[]; fields: Record<string, FieldValue> }>;
}) {
  let batch: ComplaintBatch;
  try {
    batch = await params.store.create(params.userId, params.links);
  } catch {
    return {
      success: false,
      submitted: false,
      error: "无法保存举报批次，尚未向举报服务提交，请联系管理员检查存储。",
    };
  }
  const instruction =
    "举报服务接收任务不等于已提交到平台。请保留 batchId，使用 complaint_task_status({batchId}) 查询本批次全部链接的真实状态；不要重提已接收或结果未知的链接。";
  const result = () => ({
    ...batchReferences(batch),
    submittedLinks: batch.entries.filter((e) => e.acceptance === "accepted").map((e) => e.link),
    failedLinks: batch.entries.filter((e) => e.acceptance === "rejected").map((e) => e.link),
    unknownLinks: batch.entries
      .filter((e) => e.acceptance === "unknown" || e.acceptance === "inflight")
      .map((e) => e.link),
    pendingLinks: batch.entries.filter((e) => e.acceptance === "not_attempted").map((e) => e.link),
    agentInstruction: instruction,
  });
  for (const request of params.requests) {
    const entries = batch.entries.filter((entry) => request.links.includes(entry.link));
    for (const entry of entries) {
      entry.acceptance = "inflight";
    }
    try {
      await params.store.save(batch);
    } catch {
      for (const entry of entries) {
        entry.acceptance = "not_attempted";
      }
      return {
        success: false,
        submitted: false,
        ...result(),
        error: "保存批次进度失败，已停止后续提交；请按批次查询核对，勿自动重提。",
      };
    }
    let response: Record<string, unknown>;
    try {
      response = await postForm(
        params.config,
        "/legal/save-complaint-job",
        request.fields,
        params.apiKey,
      );
    } catch {
      for (const entry of entries) {
        entry.acceptance = "unknown";
      }
      // The durable inflight state also means unknown if this checkpoint fails.
      try {
        await params.store.save(batch);
      } catch {
        /* Preserve the earlier checkpoint. */
      }
      return {
        success: false,
        submitted: false,
        ...result(),
        error: "提交连接异常，当前链接是否入队未知。请核对批次状态，不要自动重试。",
      };
    }
    const id = Number(response.taskId);
    const taskId = Number.isSafeInteger(id) && id > 0 ? id : null;
    const accepted =
      !envelopeError(response) && response.code === "success" && response.submitted !== false;
    const uncertain =
      response.recoveryRequired === true || response.errorCode === "SUBMISSION_UNKNOWN";
    for (const entry of entries) {
      entry.taskId = taskId;
      entry.acceptance = accepted ? "accepted" : uncertain ? "unknown" : "rejected";
    }
    try {
      await params.store.save(batch);
    } catch {
      return {
        success: false,
        submitted: false,
        ...result(),
        error:
          "举报请求已发出，但保存结果失败。已停止后续提交；请保留返回的任务 ID 核查，不要重提。",
      };
    }
    if (!accepted) {
      return {
        success: false,
        submitted: false,
        ...result(),
        error: asString(response.message) ?? "后端未确认接收举报请求。",
      };
    }
  }
  return {
    success: true,
    submitted: true,
    ...result(),
    message: "举报任务已提交至举报服务，是否已提交到目标平台尚待批次状态查询确认。",
  };
}
