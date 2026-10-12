import { ComplaintBatchStore, type ComplaintBatch } from "./complaint-batch-store.js";
import type { LocalComplaintItem, LocalConfig, LocalOutcome } from "./complaint-local-contract.js";
import { runLocalComplaint, type RunLocalComplaint } from "./complaint-local-process.js";

// Discovery and service registration must share lifecycle ownership in one host process.
const runtime = globalThis as typeof globalThis & {
  __leadingLocalComplaints?: Map<string, { controller: AbortController; done: Promise<void> }>;
};
const active = (runtime.__leadingLocalComplaints ??= new Map());

export async function waitForLocalBatch(batchId: string) {
  await active.get(batchId)?.done;
}
export async function stopLocalComplaints() {
  const jobs = [...active.values()];
  for (const job of jobs) {
    job.controller.abort();
  }
  await Promise.allSettled(jobs.map((job) => job.done));
}

export async function submitLocalBatch(params: {
  store: ComplaintBatchStore;
  userId: string;
  items: LocalComplaintItem[];
  config: LocalConfig;
  run?: RunLocalComplaint;
}) {
  const { store, userId, items, config } = params;
  const batch = await store.create(
    userId,
    items.map((item) => item.link),
  );
  batch.executor = "local";
  for (const entry of batch.entries) {
    entry.execution = { state: "pending", message: "本地等待执行", offline: null };
  }
  await store.save(batch);
  const controller = new AbortController();
  const run = params.run ?? runLocalComplaint;
  const execute = async () => {
    for (const [index, entry] of batch.entries.entries()) {
      if (controller.signal.aborted) {
        break;
      }
      entry.acceptance = "inflight";
      entry.execution = {
        state: "running",
        message: items[index].report12377
          ? "12377匿名流程：请在执行机浏览器核对表单、完成验证码并手动提交。"
          : "本地浏览器正在执行",
        offline: null,
      };
      // No execution until the inflight checkpoint is durable.
      await store.save(batch);
      let outcome: LocalOutcome;
      try {
        outcome = await run({
          item: items[index],
          sessionDir: store.sessionDirectory(userId),
          config,
          signal: controller.signal,
        });
      } catch {
        outcome = {
          state: "unknown",
          message: "执行中断或返回结果无法确认；请人工核对，不要自动重提。",
          offline: null,
          errorCode: "EXECUTION_INTERRUPTED",
        };
      }
      entry.execution = outcome;
      entry.acceptance =
        outcome.state === "done"
          ? "accepted"
          : outcome.state === "unknown"
            ? "unknown"
            : "rejected";
      await store.save(batch);
      if (outcome.state === "unknown" || outcome.state === "manual_required") {
        break;
      }
    }
  };
  // Store failures leave the last durable state visible; never continue or retry submission.
  const done = new Promise<void>((resolve) => setImmediate(resolve))
    .then(execute)
    .catch(() => {})
    .finally(() => {
      active.delete(batch.batchId);
    });
  active.set(batch.batchId, { controller, done });
  return {
    success: true,
    accepted: true,
    submitted: false,
    executor: "local",
    batchId: batch.batchId,
    queuedLinks: items.map((item) => item.link),
    manualBrowserActionRequired: items.some((item) => Boolean(item.report12377)),
    message: "举报批次已保存，将由本地 Python 执行；尚未确认提交到平台。",
    agentInstruction:
      "使用 complaint_task_status({batchId}) 查询逐链接结果。不要把本地接收视为平台提交成功，不得自动重提。",
  };
}

export function queryLocalBatch(batch: ComplaintBatch) {
  const running = active.has(batch.batchId);
  const links = batch.entries.map((entry) => {
    const execution = entry.execution;
    const state = !execution
      ? "not_submitted"
      : !running && execution.state === "running"
        ? "unknown"
        : !running && execution.state === "pending"
          ? "not_submitted"
          : execution.state;
    return {
      link: entry.link,
      taskId: null,
      acceptance: entry.acceptance,
      state,
      submissionStatus: state === "done" ? "Done" : null,
      failureReason:
        state === "unknown"
          ? "无法确认执行结果，请人工核对，禁止自动重提。"
          : (execution?.message ?? null),
      offline: execution?.offline ?? null,
      errorCode: execution?.errorCode ?? null,
      queryCode: execution?.queryCode ?? null,
    };
  });
  return {
    success: true,
    mode: "batch",
    executor: "local",
    batchId: batch.batchId,
    createdAt: batch.createdAt,
    summary: {
      total: links.length,
      submitted: links.filter((e) => e.state === "done").length,
      processing: links.filter((e) => e.state === "running" || e.state === "pending").length,
      failed: links.filter((e) => e.state === "failed").length,
      manualRequired: links.filter((e) => e.state === "manual_required").length,
      unknown: links.filter((e) => e.state === "unknown").length,
      notSubmitted: links.filter((e) => e.state === "not_submitted").length,
      offline: links.filter((e) => e.offline === true).length,
    },
    links,
    agentInstruction:
      "只有 done 表示观察到平台提交成功提示，不代表受理或处置。manual_required 需要在执行机处理登录/验证。unknown 禁止自动重提。offline 与提交结果独立。",
  };
}
