import { z } from "zod";
import { execute } from "../client/db-client.js";
import type { MySqlConfig } from "../client/types.js";
import type { ComplaintBatch } from "./complaint-batch-store.js";
import type { LocalComplaintItem } from "./complaint-local-contract.js";

const positiveId = z.number().int().positive().safe();
const ownerId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(positiveId);

export type ComplaintTaskRecord = {
  taskId: number;
  save: (batch: ComplaintBatch) => Promise<void>;
};

/** Audit only: never publish to the legacy complaint queue or call its submit API. */
export async function createComplaintTaskRecord(
  db: MySqlConfig | undefined,
  batch: ComplaintBatch,
  items: LocalComplaintItem[],
): Promise<ComplaintTaskRecord> {
  if (!db) {
    throw new Error("Complaint task recording requires backend.db");
  }
  const uid = ownerId.parse(batch.userId);
  const userId = batch.userId;
  const batchId = z.string().uuid().parse(batch.batchId);
  const slug = batchId.replaceAll("-", "");
  const links = batch.entries.map((entry) => entry.link);
  if (items.length !== links.length || items.some((item, index) => item.link !== links[index])) {
    throw new Error("Complaint task links do not match the local batch");
  }
  const reason = (current: ComplaintBatch) => {
    const counts = new Map<string, number>();
    for (const entry of current.entries) {
      const state = entry.execution?.state ?? "not_submitted";
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const summary = [...counts.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([state, count]) => `${state}=${count}`)
      .join(", ");
    const failure = current.entries.find((entry) => entry.execution?.errorCode)?.execution;
    const text =
      `[OpenClaw local batch=${batchId}] ${summary}` +
      (failure ? `; ${failure.errorCode}: ${failure.message}` : "") +
      `\n用户提交事由（非核实结论）：${items.map((item) => item.reason).join("\n")}`;
    // Match the existing task API's 800-character reason limit, including astral characters.
    return Array.from(text).slice(0, 800).join("");
  };
  // Stop is intentional: a local audit row must not become a runnable backend queue task.
  // A plain INSERT is not retried; an ambiguous connection failure must not create duplicates.
  const result = await execute(
    db,
    "INSERT INTO legal_complaint_task (slug, jobId, uid, groupId, date, updateDate, links, reason, status) " +
      "VALUES (?, 0, ?, 0, NOW(), NOW(), ?, ?, 'Stop')",
    [slug, uid, JSON.stringify(links), reason(batch)],
  );
  const taskId = positiveId.parse(result.insertId);
  return {
    taskId,
    async save(current) {
      if (
        current.batchId !== batchId ||
        current.userId !== userId ||
        current.entries.length !== links.length ||
        current.entries.some(
          (entry, index) => entry.link !== links[index] || entry.taskId !== taskId,
        )
      ) {
        throw new Error("Complaint task ownership or links changed");
      }
      const status = current.entries.every((entry) => entry.execution?.state === "done")
        ? "Done"
        : "Stop";
      const updated = await execute(
        db,
        "UPDATE legal_complaint_task SET status = ?, reason = ?, updateDate = NOW() " +
          "WHERE id = ? AND uid = ? AND slug = ?",
        [status, reason(current), taskId, uid, slug],
        { idempotent: true },
      );
      if (updated.affectedRows !== 1) {
        throw new Error("Complaint task record is missing or no longer owned by this batch");
      }
    },
  };
}
