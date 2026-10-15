import type { ResultSetHeader } from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../client/db-client.js";
import type { ComplaintBatch } from "./complaint-batch-store.js";
import type { LocalComplaintItem } from "./complaint-local-contract.js";
import { createComplaintTaskRecord } from "./complaint-task-record.js";

vi.mock("../client/db-client.js", () => ({ execute: vi.fn() }));
const db = {
  host: "db.example.test",
  port: 3306,
  user: "fixture",
  password: "fixture",
  database: "fixture",
};
const link = "https://www.douyin.com/video/1234567890123456789";
const items: LocalComplaintItem[] = [
  {
    link,
    platform: "douyin",
    category: "平台核查",
    reason: "仅作为用户提交的原始事由保存，不代表已证实任何违规。",
    role: "Personal",
  },
];
let batch: ComplaintBatch;
beforeEach(() => {
  vi.mocked(execute)
    .mockReset()
    .mockResolvedValue({ insertId: 42, affectedRows: 1 } as ResultSetHeader);
  batch = {
    version: 1,
    batchId: "12345678-1234-4234-8234-123456789abc",
    userId: "17",
    createdAt: new Date().toISOString(),
    executor: "local",
    entries: [{ link, acceptance: "not_attempted", taskId: null }],
  };
});

describe("local complaint task audit", () => {
  it("creates a stopped audit task owned by the current user without queue dispatch", async () => {
    const record = await createComplaintTaskRecord(db, batch, items);
    expect(record.taskId).toBe(42);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      db,
      expect.stringContaining("VALUES (?, 0, ?, 0, NOW(), NOW(), ?, ?, 'Stop')"),
      [
        "12345678123442348234123456789abc",
        17,
        JSON.stringify([link]),
        expect.stringContaining("非核实结论"),
      ],
    );
  });

  it("rejects missing configuration and invalid owners before any write", async () => {
    await expect(createComplaintTaskRecord(undefined, batch, items)).rejects.toThrow("backend.db");
    batch.userId = "17 OR 1=1";
    await expect(createComplaintTaskRecord(db, batch, items)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects mismatched links and malformed task IDs", async () => {
    await expect(createComplaintTaskRecord(db, batch, [])).rejects.toThrow("links");
    vi.mocked(execute).mockResolvedValue({ insertId: 0, affectedRows: 1 } as ResultSetHeader);
    await expect(createComplaintTaskRecord(db, batch, items)).rejects.toThrow();
  });

  it("does not retry a potentially committed insert", async () => {
    vi.mocked(execute).mockRejectedValue(new Error("connection lost after commit"));
    await expect(createComplaintTaskRecord(db, batch, items)).rejects.toThrow("connection lost");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["done", "manual_required", "unknown", "running"] as const)(
    "records %s without marking unfinished reports done",
    async (state) => {
      const record = await createComplaintTaskRecord(db, batch, items);
      batch.entries[0].taskId = record.taskId;
      batch.entries[0].execution = {
        state,
        message: "browser fixture",
        offline: null,
        errorCode: "TEST_STATE",
      };
      await record.save(batch);
      expect(execute).toHaveBeenLastCalledWith(
        db,
        expect.stringContaining("WHERE id = ? AND uid = ? AND slug = ?"),
        [
          state === "done" ? "Done" : "Stop",
          expect.stringContaining(`TEST_STATE: browser fixture`),
          42,
          17,
          "12345678123442348234123456789abc",
        ],
        { idempotent: true },
      );
    },
  );

  it("does not mark a partially completed batch done", async () => {
    const second = { ...items[0], link: `${link}?part=2` };
    batch.entries.push({ link: second.link, acceptance: "not_attempted", taskId: null });
    const record = await createComplaintTaskRecord(db, batch, [...items, second]);
    for (const entry of batch.entries) {
      entry.taskId = record.taskId;
    }
    batch.entries[0].execution = { state: "done", message: "fixture", offline: null };
    await record.save(batch);
    expect(vi.mocked(execute).mock.lastCall?.[2]?.[0]).toBe("Stop");
  });

  it("rejects an update to another owner's task", async () => {
    const record = await createComplaintTaskRecord(db, batch, items);
    batch.entries[0].taskId = record.taskId;
    await expect(record.save({ ...batch, userId: "18" })).rejects.toThrow("ownership");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports missing rows instead of silently losing progress", async () => {
    const record = await createComplaintTaskRecord(db, batch, items);
    batch.entries[0].taskId = record.taskId;
    vi.mocked(execute).mockResolvedValue({ affectedRows: 0 } as ResultSetHeader);
    await expect(record.save(batch)).rejects.toThrow("missing");
  });

  it("bounds stored reason length without splitting unicode", async () => {
    await createComplaintTaskRecord(db, batch, [{ ...items[0], reason: "𠀀".repeat(6000) }]);
    const reason = String(vi.mocked(execute).mock.lastCall?.[2]?.[3]);
    expect(Array.from(reason)).toHaveLength(800);
    expect(reason.endsWith("𠀀")).toBe(true);
  });
});
