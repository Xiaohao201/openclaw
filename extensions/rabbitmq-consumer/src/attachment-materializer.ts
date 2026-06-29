import { constants } from "node:fs";
import { copyFile, mkdir, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRuntimeConfigSnapshot, resolveAgentWorkspaceDir, type PluginLogger } from "../api.js";
import type { AttachmentRef } from "./types.js";

/**
 * Materialize large-sheet attachments (originals persisted by the frontend to a
 * shared inbox) into the user's agent workspace, so the agent's file/code tools
 * — which are contained to the workspace — can read full row-level data on
 * demand instead of estimating from the inline 15-row sample.
 *
 * Transfer is plan A1: a neutral inbox directory the frontend writes and this
 * consumer reads. On a single host os.tmpdir() matches, so the default works
 * out of the box; cross-host, set ATTACHMENT_INBOX to the same shared path on
 * both sides. The inbox copy is removed after a successful materialize.
 */

/** A spreadsheet now sitting in the agent workspace, ready for full-data reads. */
export interface MaterializedAttachment {
  /** Original filename, for the prompt. */
  filename: string;
  /** Path relative to the workspace root (what the agent reads), e.g. uploads/<id>-<name>. */
  workspacePath: string;
  /** SheetJS-computed total data rows (excluding headers). */
  totalDataRows: number;
}

/** Must mirror the frontend's resolveInboxDir default. */
const resolveInboxDir = (): string =>
  process.env.ATTACHMENT_INBOX?.trim() || path.join(os.tmpdir(), "openclaw-attachments");

/** Subdirectory under the workspace where uploads land. */
const UPLOADS_SUBDIR = "uploads";

/** Strip path separators and parent refs so a filename can't escape uploads/. */
const sanitizeFilename = (name: string): string =>
  path.basename(name).replace(/[\\/]/g, "_").replace(/\.\.+/g, ".").trim() || "file";

/**
 * Copy each attachment from the inbox into `<workspace>/uploads/`. Returns the
 * ones that landed successfully (relative workspace paths). Never throws: a
 * failed attachment is logged and skipped so the turn degrades to the inline
 * overview+sample rather than erroring the whole chat.
 */
export async function materializeAttachments(
  attachments: AttachmentRef[],
  agentId: string,
  logger: PluginLogger,
): Promise<MaterializedAttachment[]> {
  if (!attachments.length) {
    return [];
  }

  const cfg = getRuntimeConfigSnapshot();
  if (!cfg) {
    logger.warn("[ATTACHMENT] No runtime config snapshot; cannot resolve workspace, skipping");
    return [];
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const uploadsDir = path.join(workspaceDir, UPLOADS_SUBDIR);
  const inboxDir = resolveInboxDir();

  try {
    await mkdir(uploadsDir, { recursive: true });
  } catch (err) {
    logger.error(`[ATTACHMENT] Failed to create uploads dir ${uploadsDir}: ${String(err)}`);
    return [];
  }

  const results: MaterializedAttachment[] = [];
  for (const att of attachments) {
    if (att.kind !== "spreadsheet" || att.storage !== "inbox") {
      continue;
    }
    const src = path.join(inboxDir, att.ref);
    // Prefix with fileId to avoid collisions when two uploads share a name.
    const destName = `${att.fileId}-${sanitizeFilename(att.filename)}`;
    const dest = path.join(uploadsDir, destName);
    try {
      await access(src, constants.R_OK);
      await copyFile(src, dest);
      // Best-effort inbox cleanup; the workspace copy is the durable one.
      await rm(src, { force: true }).catch(() => {});
      results.push({
        filename: att.filename,
        workspacePath: `${UPLOADS_SUBDIR}/${destName}`,
        totalDataRows: att.totalDataRows,
      });
      logger.info(
        `[ATTACHMENT] Materialized "${att.filename}" -> ${UPLOADS_SUBDIR}/${destName} ` +
          `(agent ${agentId}, ${att.totalDataRows} rows)`,
      );
    } catch (err) {
      logger.warn(
        `[ATTACHMENT] Failed to materialize "${att.filename}" from ${src} (skipping): ${String(err)}`,
      );
    }
  }
  return results;
}
