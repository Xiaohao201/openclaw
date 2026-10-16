import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import type { ComplaintBatch } from "./complaint-batch-store.js";
import { parseLocalRequest, resolveLocalConfig } from "./complaint-local-contract.js";
import { submitRecordedLocalComplaint } from "./complaint-local-submission.js";

const mocks = vi.hoisted(() => ({
  createBatch: vi.fn(),
  saveBatch: vi.fn(),
  createRecord: vi.fn(),
  saveRecord: vi.fn(),
  checkRuntime: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  submit: vi.fn(),
  saveResult: vi.fn(),
}));
vi.mock("./complaint-batch-store.js", () => ({
  ComplaintBatchStore: class {
    save = mocks.saveBatch;
    sessionDirectory = () => "fixture-session";
  },
}));
vi.mock("./complaint-local.js", () => ({
  createLocalBatch: mocks.createBatch,
  submitLocalBatch: mocks.submit,
}));
vi.mock("./complaint-task-record.js", () => ({ createComplaintTaskRecord: mocks.createRecord }));
vi.mock("./complaint-result-record.js", () => ({ saveComplaintResult: mocks.saveResult }));
vi.mock("./complaint-local-process.js", () => ({ checkLocalComplaintRuntime: mocks.checkRuntime }));
vi.mock("./complaint-session-handoff.js", () => ({
  sessionBrowserHandoffs: () => ({ acquire: mocks.acquire }),
}));

const items = parseLocalRequest({
  basisSource: "AgentJudgment",
  confirmed: true,
  subjectScope: "Enterprise",
  judgment: "用户已核对指定链接及举报事由，本测试不代表对真实内容的违规认定。",
  links: ["https://weibo.com/123/fixture"],
});
const api = {
  pluginConfig: {},
  runtime: { state: { resolveStateDir: () => "unused" } },
} as unknown as OpenClawPluginApi;
const params = {
  api,
  ctx: { agentId: "rabbitmq-1" },
  userId: "1",
  items,
  config: resolveLocalConfig({}),
};
let batch: ComplaintBatch;
beforeEach(() => {
  vi.resetAllMocks();
  batch = {
    version: 1,
    batchId: "12345678-1234-4234-8234-123456789abc",
    userId: "1",
    executor: "local",
    createdAt: new Date().toISOString(),
    entries: [{ link: items[0].link, taskId: null, acceptance: "not_attempted" }],
  };
  mocks.createBatch.mockResolvedValue(batch);
  mocks.saveBatch.mockResolvedValue(undefined);
  mocks.createRecord.mockResolvedValue({ taskId: 42, save: mocks.saveRecord });
  mocks.saveRecord.mockResolvedValue(undefined);
  mocks.checkRuntime.mockResolvedValue(null);
  mocks.acquire.mockResolvedValue({ handoff: {}, release: mocks.release });
  mocks.submit.mockResolvedValue({ accepted: true, submitted: false, batchId: batch.batchId });
});

describe("recorded local complaint coordination", () => {
  it("wires result recording to the executing user's session and task", async () => {
    await submitRecordedLocalComplaint(params);
    const { persistResult } = mocks.submit.mock.calls[0][0];
    await persistResult(batch, 0);
    expect(mocks.saveResult).toHaveBeenCalledExactlyOnceWith({
      db: undefined,
      batch,
      index: 0,
      item: items[0],
      sessionDir: "fixture-session",
    });
    expect(batch.entries[0].taskId).toBe(42);
  });
  it("does not insert or acquire a browser when local storage fails", async () => {
    mocks.createBatch.mockRejectedValue(new Error("disk full"));
    expect(await submitRecordedLocalComplaint(params)).toMatchObject({
      errorCode: "BATCH_RECORD_FAILED",
      submitted: false,
    });
    expect(mocks.createRecord).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("updates the audit record even if local disk writes fail", async () => {
    mocks.saveBatch.mockRejectedValue(new Error("disk full"));
    expect(await submitRecordedLocalComplaint(params)).toMatchObject({
      taskId: 42,
      persistenceError: "TASK_RECORD_SYNC_FAILED",
      submitted: false,
    });
    expect(mocks.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            taskId: 42,
            execution: expect.objectContaining({ state: "not_submitted" }),
          }),
        ],
      }),
    );
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("persists an audit sync warning on a failed preflight", async () => {
    mocks.checkRuntime.mockResolvedValue({ message: "missing runtime" });
    mocks.saveRecord.mockRejectedValue(new Error("database offline"));
    expect(await submitRecordedLocalComplaint(params)).toMatchObject({
      errorCode: "RUNTIME_MISSING",
      taskId: 42,
      persistenceError: "TASK_RECORD_SYNC_FAILED",
    });
    expect(batch.persistenceError).toBe("TASK_RECORD_SYNC_FAILED");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects mixed channels without acquiring a browser", async () => {
    const mixed = [
      ...items,
      {
        ...items[0],
        report12377: { category: "rumor", websiteName: "fixture" },
        platform: "report12377",
      },
    ];
    expect(await submitRecordedLocalComplaint({ ...params, items: mixed })).toMatchObject({
      errorCode: "MIXED_COMPLAINT_CHANNELS",
      submitted: false,
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("only uses the separate channel when it is already explicitly selected", async () => {
    const separate = [
      {
        ...items[0],
        report12377: { category: "rumor", websiteName: "fixture" },
        platform: "report12377",
      },
    ];
    expect(await submitRecordedLocalComplaint({ ...params, items: separate })).toMatchObject({
      taskId: 42,
      accepted: true,
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ items: separate }),
    );
  });

  it("releases the browser and records a failure if execution cannot start", async () => {
    mocks.submit.mockRejectedValue(new Error("startup failure"));
    expect(await submitRecordedLocalComplaint(params)).toMatchObject({
      taskId: 42,
      errorCode: "LOCAL_EXECUTION_START_FAILED",
      submitted: false,
    });
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.saveRecord).toHaveBeenCalled();
  });

  it("handles a non-Error handoff rejection without switching channels", async () => {
    mocks.acquire.mockRejectedValue(null);
    const result = await submitRecordedLocalComplaint(params);
    expect(result).toMatchObject({ errorCode: "BROWSER_HANDOFF_REQUIRED", submitted: false });
    expect(result.agentInstruction).toContain("不得推荐或切换到12377");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
