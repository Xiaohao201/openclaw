import type mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import { createHistoryPool, execWithRetry } from "./db-pool.js";
import type { HistoryDbConfig } from "./types.js";

/** One sanitized work-process step persisted alongside the report. */
export interface ReportStep {
  id: string;
  index: number;
  label: string;
  category: string;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  detail?: string;
}

/** The report payload merged into history_messages.metadata.report. */
export interface ReportMetadata {
  title: string;
  content: string;
  steps?: ReportStep[];
}

/**
 * Writes a finished report back into the originating history_messages row so
 * the lobster history view can show the full report (and its "工作过程" steps)
 * instead of only the "正在生成中..." ack that the rabbitmq-consumer stored.
 *
 * The report content otherwise lives only in the download / report_* tables and
 * is delivered to the live frontend as a transient Mercure event — never
 * associated with the chat history row. This writer closes that gap by merging
 * `{ report: {...} }` into the row's existing metadata JSON.
 */
export class ReportHistoryWriter {
  private readonly config: HistoryDbConfig;
  private pool: mysql.Pool | null = null;

  constructor(config: HistoryDbConfig) {
    this.config = config;
  }

  private getPool(): mysql.Pool {
    if (!this.pool) {
      this.pool = createHistoryPool(this.config, 2);
    }
    return this.pool;
  }

  /**
   * Merge the report into the history row's metadata. Read-modify-write so any
   * existing metadata keys (e.g. chat steps) are preserved. Best-effort: the
   * caller treats failures as non-fatal — the report itself already succeeded.
   */
  async writeReport(
    historyId: number,
    report: ReportMetadata,
    logger: PluginLogger,
  ): Promise<void> {
    const pool = this.getPool();

    const [rows] = await execWithRetry<mysql.RowDataPacket[]>(
      pool,
      "SELECT metadata FROM history_messages WHERE id = ?",
      [historyId],
    );
    if (!rows || rows.length === 0) {
      logger.warn(`[REPORT_HISTORY] history row #${historyId} not found; skip report writeback`);
      return;
    }

    // mysql2 returns a JSON column as a parsed object (or null). Tolerate a
    // legacy string value too, falling back to {} on any parse failure.
    let metadata: Record<string, unknown> = {};
    const raw = rows[0].metadata;
    if (raw && typeof raw === "object") {
      metadata = raw as Record<string, unknown>;
    } else if (typeof raw === "string" && raw.trim()) {
      try {
        metadata = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }

    metadata.report = {
      title: report.title,
      content: report.content,
      ...(report.steps && report.steps.length > 0 ? { steps: report.steps } : {}),
    };

    await execWithRetry(pool, "UPDATE history_messages SET metadata = ? WHERE id = ?", [
      JSON.stringify(metadata),
      historyId,
    ]);
    logger.info(`[REPORT_HISTORY] Wrote report into history row #${historyId}`);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
