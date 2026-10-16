import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../client/http-client.js";
import { ComplaintBatchStore, type ComplaintBatch } from "./complaint-batch-store.js";
import type { LocalComplaintItem, LocalConfig } from "./complaint-local-contract.js";
import { checkLocalComplaintRuntime } from "./complaint-local-process.js";
import { createLocalBatch, submitLocalBatch } from "./complaint-local.js";
import { saveComplaintResult } from "./complaint-result-record.js";
import { sessionBrowserHandoffs } from "./complaint-session-handoff.js";
import { createComplaintTaskRecord, type ComplaintTaskRecord } from "./complaint-task-record.js";

export const KEEP_COMPLAINT_CHANNEL =
  "保留原平台渠道。未获用户明确指定，不得推荐或切换到12377或其他举报渠道；登录、浏览器交接或取证失败不构成更换渠道的理由。";

export async function submitRecordedLocalComplaint(params: {
  api: OpenClawPluginApi;
  ctx: { agentId?: string; sessionKey?: string; sessionId?: string };
  userId: string;
  items: LocalComplaintItem[];
  config: LocalConfig;
}) {
  const { api, ctx, userId, items, config } = params;
  const store = new ComplaintBatchStore(() => api.runtime.state.resolveStateDir());
  let batch: ComplaintBatch;
  try {
    batch = await createLocalBatch(store, userId, items);
  } catch {
    return {
      success: false,
      accepted: false,
      submitted: false,
      errorCode: "BATCH_RECORD_FAILED",
      error: "无法保存本地批次，未执行举报。",
      agentInstruction: KEEP_COMPLAINT_CHANNEL,
    };
  }
  let record: ComplaintTaskRecord | undefined;
  const stopped = async (
    errorCode: string,
    message: string,
    state: "not_submitted" | "manual_required" = "not_submitted",
  ) => {
    for (const entry of batch.entries) {
      entry.acceptance = "rejected";
      entry.execution = { state, message, errorCode, offline: null };
    }
    let persistenceError: string | undefined;
    try {
      await store.save(batch);
    } catch {
      persistenceError = "TASK_RECORD_SYNC_FAILED";
    }
    try {
      await record?.save(batch);
    } catch {
      persistenceError = "TASK_RECORD_SYNC_FAILED";
    }
    if (persistenceError) {
      batch.persistenceError = "TASK_RECORD_SYNC_FAILED";
      try {
        await store.save(batch);
      } catch {
        // Return the IDs and sync failure even when the local checkpoint is unavailable.
      }
    }
    return {
      success: false,
      accepted: false,
      submitted: false,
      executor: "local",
      batchId: batch.batchId,
      taskId: record?.taskId ?? null,
      ...(persistenceError ? { persistenceError } : {}),
      errorCode,
      error: message,
      agentInstruction: `尚未提交平台。使用 complaint_task_status({batchId}) 核对记录；不要自动重提或声称成功。${KEEP_COMPLAINT_CHANNEL}`,
    };
  };
  try {
    record = await createComplaintTaskRecord(
      resolveConfig(api.pluginConfig ?? {}).db,
      batch,
      items,
    );
    for (const entry of batch.entries) {
      entry.taskId = record.taskId;
    }
    await store.save(batch);
  } catch {
    return stopped(
      "TASK_RECORD_FAILED",
      "举报任务记录未确认保存，未执行举报。请检查 backend.db 和批次记录；入库结果可能未知，不得自动重提。",
    );
  }
  const unavailable = await checkLocalComplaintRuntime(config);
  if (unavailable) {
    return stopped(unavailable.errorCode ?? "RUNTIME_MISSING", unavailable.message);
  }
  let browserLease;
  try {
    if (items.some((item) => !item.report12377)) {
      if (items.some((item) => item.report12377)) {
        return stopped("MIXED_COMPLAINT_CHANNELS", "不同举报渠道不能混合在同一批次。");
      }
      browserLease = await sessionBrowserHandoffs(api).acquire(ctx);
    }
  } catch (error) {
    return stopped(
      "BROWSER_HANDOFF_REQUIRED",
      error instanceof Error ? error.message : "当前浏览器无法交接。",
      "manual_required",
    );
  }
  try {
    const result = await submitLocalBatch({
      store,
      userId,
      items,
      config,
      browserLease,
      batch,
      persistTask: record.save,
      persistResult: (current, index) =>
        saveComplaintResult({
          db: resolveConfig(api.pluginConfig ?? {}).db,
          batch: current,
          index,
          item: items[index],
          sessionDir: store.sessionDirectory(userId),
        }),
    });
    return { ...result, taskId: record.taskId };
  } catch {
    browserLease?.release();
    return stopped(
      "LOCAL_EXECUTION_START_FAILED",
      "本地执行未启动，请核对批次记录。不得自动重提。",
    );
  }
}
