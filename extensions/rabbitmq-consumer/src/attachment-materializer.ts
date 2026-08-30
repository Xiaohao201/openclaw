import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, type OpenClawConfig, type PluginLogger } from "../api.js";
import type { AttachmentRef } from "./types.js";

/**
 * Materialize original attachments uploaded by the frontend to OSS into the
 * user's agent workspace. This preserves full spreadsheets and evidence files
 * such as stamped PDFs whose layout and images are lost during text extraction.
 *
 * Transfer is plan A2: the frontend and this consumer run on different hosts
 * (no shared filesystem), so the file travels via OSS. The frontend uploads the
 * original and sends a public direct link; here we HTTP GET that link and write
 * it under <workspace>/uploads/. No OSS SDK/credentials are needed on this side.
 */

/** A file now sitting in the agent workspace, ready for the agent to read. */
export interface MaterializedAttachment {
  /** What the file is: a data spreadsheet, original document, or 证件 image. */
  kind: "spreadsheet" | "document" | "image";
  /** Original filename, for the prompt. */
  filename: string;
  /** Path relative to the workspace root (what the agent reads), e.g. uploads/<id>-<name>. */
  workspacePath: string;
  /** SheetJS-computed total data rows (excluding headers); spreadsheet only. */
  totalDataRows?: number;
  /** OSS object key supplied by the producer, usable by complaint/profile tools. */
  ossKey?: string;
  /** Original public OSS URL, retained as a fallback when an older producer omitted ossKey. */
  ossUrl: string;
}

/** Subdirectory under the workspace where uploads land. */
const UPLOADS_SUBDIR = "uploads";

/** Cap on a single attachment download, so a bad/huge link can't exhaust memory. */
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024; // 60MB (frontend caps uploads at 50MB)

/** Abort a stuck download rather than blocking the chat turn. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Strip path separators and parent refs so a filename can't escape uploads/. */
const sanitizeFilename = (name: string): string =>
  path.basename(name).replace(/[\\/]/g, "_").replace(/\.\.+/g, ".").trim() || "file";

/** Download an OSS public link into a buffer, bounded by size and time. */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download too large (${buf.byteLength} bytes)`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download each attachment from OSS into `<workspace>/uploads/`. Returns the
 * ones that landed successfully (relative workspace paths). Never throws: a
 * failed attachment is logged and skipped so the turn degrades to the inline
 * overview+sample rather than erroring the whole chat.
 */
export async function materializeAttachments(
  attachments: AttachmentRef[],
  agentId: string,
  config: OpenClawConfig,
  logger: PluginLogger,
): Promise<MaterializedAttachment[]> {
  if (!attachments.length) {
    return [];
  }

  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const uploadsDir = path.join(workspaceDir, UPLOADS_SUBDIR);

  try {
    await mkdir(uploadsDir, { recursive: true });
  } catch (err) {
    logger.error(`[ATTACHMENT] Failed to create uploads dir ${uploadsDir}: ${String(err)}`);
    return [];
  }

  const results: MaterializedAttachment[] = [];
  for (const att of attachments) {
    // Spreadsheets, original documents, and images all land in the workspace;
    // anything else / non-OSS is skipped.
    if (
      (att.kind !== "spreadsheet" && att.kind !== "document" && att.kind !== "image") ||
      att.storage !== "oss"
    ) {
      continue;
    }
    // Prefix with fileId to avoid collisions when two uploads share a name.
    const destName = `${att.fileId}-${sanitizeFilename(att.filename)}`;
    const dest = path.join(uploadsDir, destName);
    try {
      const buf = await downloadToBuffer(att.ref);
      await writeFile(dest, buf);
      results.push({
        kind: att.kind,
        filename: att.filename,
        workspacePath: `${UPLOADS_SUBDIR}/${destName}`,
        totalDataRows: att.totalDataRows,
        ossKey: att.ossKey,
        ossUrl: att.ref,
      });
      logger.info(
        `[ATTACHMENT] Downloaded ${att.kind} "${att.filename}" -> ${UPLOADS_SUBDIR}/${destName} ` +
          `(agent ${agentId}, ${buf.byteLength} bytes)`,
      );
    } catch (err) {
      logger.warn(
        `[ATTACHMENT] Failed to download "${att.filename}" from ${att.ref} (skipping): ${String(err)}`,
      );
    }
  }
  return results;
}
