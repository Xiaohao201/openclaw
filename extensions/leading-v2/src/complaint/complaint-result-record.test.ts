import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute, query } from "../client/db-client.js";
import type { ComplaintBatch } from "./complaint-batch-store.js";
import { uploadComplaintScreenshot } from "./complaint-evidence.runtime.js";
import { saveComplaintResult } from "./complaint-result-record.js";

vi.mock("../client/db-client.js", () => ({ execute: vi.fn(), query: vi.fn() }));
vi.mock("./complaint-evidence.runtime.js", () => ({ uploadComplaintScreenshot: vi.fn() }));
const diagnosticWarn = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: () => ({ warn: diagnosticWarn }),
}));
const db = {
  host: "fixture",
  port: 3306,
  user: "fixture",
  password: "fixture",
  database: "fixture",
};
const item = {
  platform: "weibo",
  link: "https://weibo.com/fixture",
  category: "不实信息",
  reason: "用户提交的待核实事由",
  role: "Personal" as const,
};
let batch: ComplaintBatch;
const save = () => saveComplaintResult({ db, batch, index: 0, item, sessionDir: "fixture" });
beforeEach(() => {
  vi.resetAllMocks();
  item.reason = "用户提交的待核实事由";
  vi.mocked(execute).mockResolvedValue({ insertId: 123, affectedRows: 1 } as ResultSetHeader);
  vi.mocked(query).mockResolvedValue([{ id: 123 } as RowDataPacket]);
  vi.mocked(uploadComplaintScreenshot).mockResolvedValue("https://images.example.test/receipt.png");
  batch = {
    version: 1,
    batchId: "12345678-1234-4234-8234-123456789abc",
    userId: "17",
    createdAt: new Date().toISOString(),
    executor: "local",
    entries: [
      {
        link: item.link,
        taskId: 42,
        acceptance: "accepted",
        execution: {
          state: "done",
          message: "平台提交成功",
          offline: null,
          screenshot: { fileName: "a".repeat(32) + ".png", capturedAt: "2026-10-16T00:00:00Z" },
        },
      },
    ],
  };
});
describe("complaint result recording", () => {
  it("records the failing database operation and code without SQL or credentials", async () => {
    vi.mocked(execute).mockRejectedValueOnce(
      Object.assign(new Error("private password and SQL"), {
        code: "ETIMEDOUT",
        errno: 1205,
        sqlState: "HY000",
      }),
    );
    await expect(save()).rejects.toThrow("RESULT_RECORD_SYNC_FAILED");
    const logged = diagnosticWarn.mock.calls[0][0] as string;
    expect(logged).toContain('"stage":"insert_detail"');
    expect(logged).toContain('"code":"ETIMEDOUT"');
    expect(logged).toContain(batch.batchId);
    expect(logged).not.toContain("private");
    expect(logged).not.toContain(item.link);
  });
  it("upserts one owned detail and records its uploaded receipt and actual submission state", async () => {
    await save();
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("LAST_INSERT_ID(legal_complaint.id)");
    expect(execute).toHaveBeenCalledWith(
      db,
      expect.stringContaining("INSERT INTO legal_complaint "),
      expect.arrayContaining([42, 17, item.link, "Weibo"]),
      { idempotent: true },
    );
    expect(execute).toHaveBeenLastCalledWith(
      db,
      expect.stringContaining("AND taskId = ? AND uid = ?"),
      expect.arrayContaining(["Done", "https://images.example.test/receipt.png", 123, 42, 17]),
      { idempotent: true },
    );
    expect(batch.entries[0].recording).toMatchObject({
      state: "saved",
      complaintId: 123,
      screenshotUrl: "https://images.example.test/receipt.png",
    });
    await save();
    expect(uploadComplaintScreenshot).toHaveBeenCalledTimes(1);
  });
  it("keeps a successful platform result when screenshot upload fails", async () => {
    batch.entries[0].execution!.message = "long result ".repeat(100);
    vi.mocked(uploadComplaintScreenshot).mockRejectedValue(new Error("private credential detail"));
    await expect(save()).rejects.toThrow();
    expect(batch.entries[0].execution?.state).toBe("done");
    expect(batch.entries[0].recording).toMatchObject({
      state: "failed",
      complaintId: 123,
      errorCode: "SCREENSHOT_UPLOAD_FAILED",
    });
    expect(execute).toHaveBeenLastCalledWith(
      db,
      expect.stringContaining("UPDATE legal_complaint SET"),
      expect.arrayContaining(["Done", expect.stringContaining("SCREENSHOT_UPLOAD_FAILED")]),
      { idempotent: true },
    );
    expect(JSON.stringify(batch)).not.toContain("private");
  });
  it("checks the current parent task owner before any detail update", async () => {
    await save();
    expect(query).toHaveBeenCalledWith(
      db,
      expect.stringContaining("JOIN legal_complaint_task"),
      expect.arrayContaining([42, 17, batch.batchId.replaceAll("-", "")]),
    );
    expect(vi.mocked(execute).mock.lastCall?.[1]).toContain("EXISTS");
  });
  it("retains the uploaded screenshot if the database update must be retried", async () => {
    vi.mocked(execute)
      .mockResolvedValueOnce({ affectedRows: 1 } as ResultSetHeader)
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(save()).rejects.toThrow("RESULT_RECORD_SYNC_FAILED");
    expect(batch.entries[0].recording?.screenshotUrl).toBe(
      "https://images.example.test/receipt.png",
    );
    await save();
    expect(uploadComplaintScreenshot).toHaveBeenCalledTimes(1);
  });
  it("does not turn missing screenshots into a failed or repeated platform submission", async () => {
    delete batch.entries[0].execution!.screenshot;
    await expect(save()).rejects.toThrow();
    expect(batch.entries[0].execution!.state).toBe("done");
    expect(batch.entries[0].recording).toMatchObject({ errorCode: "SCREENSHOT_MISSING" });
    expect(uploadComplaintScreenshot).not.toHaveBeenCalled();
  });
  it.each([
    ["unknown", "Stop"],
    ["failed", "Fail"],
    ["manual_required", "Stop"],
  ] as const)("records %s without falsely setting Done", async (state, status) => {
    batch.entries[0].execution!.state = state;
    delete batch.entries[0].execution!.screenshot;
    await save();
    expect(vi.mocked(execute).mock.lastCall?.[2]?.[0]).toBe(status);
  });
  it("refuses another task's record before uploading or updating", async () => {
    vi.mocked(query).mockResolvedValue([]);
    await expect(save()).rejects.toThrow();
    expect(uploadComplaintScreenshot).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("keeps a stable unique slug for a task/link and binds all values", async () => {
    item.reason = "quote ' and SQL-looking content --";
    await save();
    const first = vi.mocked(execute).mock.calls[0];
    expect(first[1]).not.toContain(item.reason);
    await save();
    expect(vi.mocked(execute).mock.calls[2][2]?.[0]).toBe(first[2]?.[0]);
  });
});
