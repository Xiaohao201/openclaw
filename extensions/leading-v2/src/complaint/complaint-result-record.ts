import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { execute, query } from "../client/db-client.js";
import type { MySqlConfig } from "../client/types.js";
import type { ComplaintBatch } from "./complaint-batch-store.js";
import type { LocalComplaintItem } from "./complaint-local-contract.js";

const idSchema = z.number().int().positive().safe();
const ownerSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(idSchema);
const platformNames: Record<string, string> = {
  baidu: "Baidu",
  bilibili: "Bilibili",
  douyin: "Douyin",
  eastmoney: "Eastmoney",
  futu: "Futu",
  kuaishou: "Kuaishou",
  netease: "Netease",
  report12377: "Report12377",
  sina: "Sina",
  sohu: "Sohu",
  tencent: "Tencent",
  tiantianfund: "Tiantianfund",
  toutiao: "Toutiao",
  weibo: "Weibo",
  xiaohongshu: "Xiaohongshu",
  yidianzixun: "Yidianzixun",
  zhihu: "Zhihu",
};
type RecordError =
  | "RESULT_RECORD_SYNC_FAILED"
  | "SCREENSHOT_MISSING"
  | "SCREENSHOT_CAPTURE_FAILED"
  | "SCREENSHOT_UPLOAD_FAILED";
const bounded = (text: string, length: number) => Array.from(text).slice(0, length).join("");
// The legacy memo/category columns are utf8mb3. Preserve readable Unicode without rejecting a result.
const legacyText = (text: string, length: number) =>
  bounded(text.replace(/[\u{10000}-\u{10ffff}]/gu, "�"), length);

/** Record execution only. Never enqueue a backend task or submit a platform report. */
export async function saveComplaintResult(params: {
  db: MySqlConfig | undefined;
  batch: ComplaintBatch;
  index: number;
  item: LocalComplaintItem;
  sessionDir: string;
}): Promise<void> {
  const { db, batch, index, item, sessionDir } = params;
  const entry = batch.entries[index];
  const outcome = entry?.execution;
  if (!outcome || outcome.state === "pending" || outcome.state === "running") {
    return;
  }
  let complaintId = entry.recording?.complaintId;
  let screenshotUrl = entry.recording?.screenshotUrl ?? undefined;
  let errorCode: RecordError = "RESULT_RECORD_SYNC_FAILED";
  try {
    if (!db || entry.link !== item.link || !platformNames[item.platform]) {
      throw new Error("Invalid complaint result context");
    }
    const uid = ownerSchema.parse(batch.userId);
    const taskId = idSchema.parse(entry.taskId);
    const batchId = z.string().uuid().parse(batch.batchId);
    const link = z.string().min(1).max(1000).parse(item.link);
    const slug = createHash("sha256")
      .update(JSON.stringify([batchId, taskId, uid, link]))
      .digest("hex");
    const status = outcome.state === "done" ? "Done" : outcome.state === "failed" ? "Fail" : "Stop";
    // A deterministic unique slug makes connection retries safe. Do not update an existing
    // row until its task, owner and exact link have been verified by the following read.
    await execute(
      db,
      "INSERT INTO legal_complaint (slug, jobId, taskId, uid, groupId, platform, link, role, reason, date, updateDate, status) " +
        "SELECT ?, 0, ?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'Stop' " +
        "FROM legal_complaint_task WHERE id = ? AND uid = ? AND slug = ? " +
        "ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
      [
        slug,
        taskId,
        uid,
        platformNames[item.platform],
        link,
        item.role,
        bounded(item.reason, 1000),
        taskId,
        uid,
        batchId.replaceAll("-", ""),
      ],
      { idempotent: true },
    );
    const rows = await query<RowDataPacket[]>(
      db,
      "SELECT c.id FROM legal_complaint c JOIN legal_complaint_task t ON t.id = c.taskId " +
        "WHERE c.slug = ? AND c.taskId = ? AND c.uid = ? AND BINARY c.link = ? AND t.uid = ? AND t.slug = ?",
      [slug, taskId, uid, link, uid, batchId.replaceAll("-", "")],
    );
    if (rows.length !== 1) {
      throw new Error("Complaint detail ownership mismatch");
    }
    complaintId = idSchema.parse(rows[0].id);

    let evidenceError: RecordError | undefined;
    if (outcome.screenshot && !screenshotUrl) {
      try {
        const { uploadComplaintScreenshot } = await import("./complaint-evidence.runtime.js");
        screenshotUrl = await uploadComplaintScreenshot(sessionDir, outcome.screenshot);
      } catch {
        evidenceError = "SCREENSHOT_UPLOAD_FAILED";
      }
    } else if (!outcome.screenshot && outcome.state === "done") {
      evidenceError = outcome.evidenceError ?? "SCREENSHOT_MISSING";
    }
    const memo = legacyText(
      `[OpenClaw ${outcome.state}] ${evidenceError ? `${evidenceError}; ` : ""}` +
        `${outcome.errorCode ?? "NONE"}: ${outcome.message}`,
      255,
    );
    const updated = await execute(
      db,
      "UPDATE legal_complaint SET status = ?, memo = ?, screenshot = ?, updateDate = NOW() " +
        "WHERE id = ? AND taskId = ? AND uid = ? AND slug = ? " +
        "AND EXISTS (SELECT 1 FROM legal_complaint_task WHERE id = ? AND uid = ? AND slug = ?)",
      [
        status,
        memo,
        screenshotUrl ?? null,
        complaintId,
        taskId,
        uid,
        slug,
        taskId,
        uid,
        batchId.replaceAll("-", ""),
      ],
      { idempotent: true },
    );
    if (updated.affectedRows !== 1) {
      throw new Error("Complaint detail no longer owned by this batch");
    }
    if (evidenceError) {
      errorCode = evidenceError;
      throw new Error(evidenceError);
    }
    entry.recording = { state: "saved", complaintId, screenshotUrl: screenshotUrl ?? null };
  } catch {
    entry.recording = {
      state: "failed",
      errorCode,
      ...(complaintId ? { complaintId } : {}),
      ...(screenshotUrl ? { screenshotUrl } : {}),
    };
    throw new Error(errorCode);
  }
}
