import type mysql from "mysql2/promise";
import {
  convertSessionTurnCost,
  hasSessionTurnUsage,
  primarySessionTurnModel,
  type PluginLogger,
  type SessionTurnCurrencyPolicy,
  type SessionTurnUsage,
} from "../api.js";
import { createHistoryPool, execWithRetry } from "./db-pool.js";
import type { HistoryDbConfig } from "./types.js";

/** DECIMAL(16,8) in the schema — round here so MySQL never truncates silently. */
const roundCost = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : 0;

const roundTokens = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

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
   * Read-modify-write a patch into the row's `metadata` JSON, preserving keys
   * other writers own (the chat pipeline's `steps`/`citations`/`usage`).
   * Returns false when the row does not exist.
   */
  private async mergeMetadata(historyId: number, patch: Record<string, unknown>): Promise<boolean> {
    const pool = this.getPool();

    const [rows] = await execWithRetry<mysql.RowDataPacket[]>(
      pool,
      "SELECT metadata FROM history_messages WHERE id = ?",
      [historyId],
    );
    if (!rows || rows.length === 0) {
      return false;
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

    await execWithRetry(pool, "UPDATE history_messages SET metadata = ? WHERE id = ?", [
      JSON.stringify({ ...metadata, ...patch }),
      historyId,
    ]);
    return true;
  }

  /**
   * Merge the report into the history row's metadata. Best-effort: the caller
   * treats failures as non-fatal — the report itself already succeeded.
   */
  async writeReport(
    historyId: number,
    report: ReportMetadata,
    logger: PluginLogger,
  ): Promise<void> {
    const written = await this.mergeMetadata(historyId, {
      report: {
        title: report.title,
        content: report.content,
        ...(report.steps && report.steps.length > 0 ? { steps: report.steps } : {}),
      },
    });
    if (!written) {
      logger.warn(`[REPORT_HISTORY] history row #${historyId} not found; skip report writeback`);
      return;
    }
    logger.info(`[REPORT_HISTORY] Wrote report into history row #${historyId}`);
  }

  /**
   * Add the report's token/cost to the originating chat row.
   *
   * Accumulates onto whatever the chat turn already billed (the conversational
   * ack was billed first, minutes earlier), so the row ends up carrying the FULL
   * cost of serving that user message — reply plus report. Provider/model
   * columns keep the chat turn's value via COALESCE; the report's own model
   * breakdown goes to metadata.reportUsage, which is a separate key from the
   * chat's metadata.usage so the two writers never clobber each other.
   *
   * Best-effort: the report already succeeded, so accounting must not fail it.
   */
  async writeUsage(
    historyId: number,
    usage: SessionTurnUsage | null | undefined,
    policy: SessionTurnCurrencyPolicy,
    logger: PluginLogger,
  ): Promise<void> {
    if (!hasSessionTurnUsage(usage) || !usage) {
      return;
    }
    const cost = convertSessionTurnCost(usage, policy);
    const primary = primarySessionTurnModel(usage);
    const pool = this.getPool();

    try {
      await execWithRetry(
        pool,
        `UPDATE history_messages SET
           input_tokens = COALESCE(input_tokens, 0) + ?,
           output_tokens = COALESCE(output_tokens, 0) + ?,
           cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
           cache_write_tokens = COALESCE(cache_write_tokens, 0) + ?,
           total_tokens = COALESCE(total_tokens, 0) + ?,
           input_cost = COALESCE(input_cost, 0) + ?,
           output_cost = COALESCE(output_cost, 0) + ?,
           cache_read_cost = COALESCE(cache_read_cost, 0) + ?,
           cache_write_cost = COALESCE(cache_write_cost, 0) + ?,
           total_cost = COALESCE(total_cost, 0) + ?,
           llm_calls = COALESCE(llm_calls, 0) + ?,
           cost_currency = ?,
           llm_provider = COALESCE(llm_provider, ?),
           llm_model = COALESCE(llm_model, ?)
         WHERE id = ?`,
        [
          roundTokens(usage.input),
          roundTokens(usage.output),
          roundTokens(usage.cacheRead),
          roundTokens(usage.cacheWrite),
          roundTokens(usage.totalTokens),
          roundCost(cost.input),
          roundCost(cost.output),
          roundCost(cost.cacheRead),
          roundCost(cost.cacheWrite),
          roundCost(cost.total),
          roundTokens(usage.calls),
          cost.currency,
          primary?.provider ?? null,
          primary?.model ?? null,
          historyId,
        ],
      );
      logger.info(
        `[REPORT_HISTORY] Billed report usage onto row #${historyId}: ` +
          `calls=${usage.calls} in=${usage.input} out=${usage.output} ` +
          `cacheRead=${usage.cacheRead} cost=${cost.total.toFixed(6)} ${cost.currency}`,
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      const hint =
        code === "ER_BAD_FIELD_ERROR"
          ? " (run extensions/rabbitmq-consumer/src/migrations/20260728-history-messages-usage.sql)"
          : "";
      logger.warn(`[REPORT_HISTORY] Report usage writeback failed${hint}: ${String(err)}`);
      return;
    }

    try {
      await this.mergeMetadata(historyId, {
        reportUsage: {
          currency: cost.currency,
          calls: usage.calls,
          tokens: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            total: usage.totalTokens,
          },
          cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead,
            cacheWrite: cost.cacheWrite,
            total: cost.total,
          },
          models: usage.models.map((m) => ({
            provider: m.provider,
            model: m.model,
            calls: m.calls,
            input: m.input,
            output: m.output,
            cacheRead: m.cacheRead,
            cacheWrite: m.cacheWrite,
            total: m.totalTokens,
            nativeCost: m.cost.total,
          })),
          ...(usage.missingCost ? { missingCost: true } : {}),
        },
      });
    } catch (metaErr) {
      logger.warn(`[REPORT_HISTORY] Report usage metadata write failed: ${String(metaErr)}`);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
