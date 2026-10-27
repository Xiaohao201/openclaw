import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExecutionJournal } from "./execution-journal.js";

describe("ExecutionJournal", () => {
  it("reports damaged journals and write failures without rejecting the task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-journal-"));
    try {
      const file = join(dir, "invalid.json");
      await writeFile(file, "not json");
      const warn = vi.fn();
      const invalid = new ExecutionJournal(file, warn);
      await invalid.load();
      expect(warn).toHaveBeenCalledOnce();
      const blocked = new ExecutionJournal(join(file, "events.json"), warn);
      blocked.record({ taskId: "t", uid: "u", at: 1, outcome: "failed" });
      await blocked.flush();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("persists a bounded history and preserves it across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-journal-"));
    const file = join(dir, "events.json");
    try {
      const journal = new ExecutionJournal(file, () => {});
      await journal.load();
      for (let i = 0; i < 1100; i++) {
        journal.record({ taskId: "t", uid: "u", at: i, outcome: "queue_expired" });
      }
      await journal.flush();
      const events = JSON.parse(await readFile(file, "utf8"));
      expect(events).toHaveLength(1000);
      expect(events[0].at).toBe(100);
      const restarted = new ExecutionJournal(file, () => {});
      await restarted.load();
      restarted.record({
        taskId: "t",
        uid: "u",
        at: 1100,
        outcome: "failed",
        note: "model timeout",
      });
      await restarted.flush();
      const persisted = JSON.parse(await readFile(file, "utf8"));
      expect(persisted).toHaveLength(1000);
      expect(persisted.at(-1)).toMatchObject({ outcome: "failed", note: "model timeout" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
