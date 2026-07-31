import mysql from "mysql2/promise";
import type { HistoryDbConfig, WriterDbConfig, HistoryRecord, TurnUsageRecord } from "./types.js";

/**
 * MySQL error code for a column that does not exist. The token/cost columns are
 * added to history_messages by a one-off schema change (applied 2026-07); until
 * a database has it, usage writes must degrade to a warning instead of erroring
 * on every turn.
 */
const ER_BAD_FIELD_ERROR = "ER_BAD_FIELD_ERROR";

/** DECIMAL(16,8) in the schema — round here so MySQL never truncates silently. */
const roundCost = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : 0;

const roundTokens = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/**
 * Manages read/write access to the history_messages MySQL table.
 * Uses separate connection pools: reader for SELECT, writer for UPDATE/INSERT.
 * Falls back to the reader pool for writes when no writer config is provided.
 */
export class HistoryManager {
  private readonly readerConfig: HistoryDbConfig;
  private readonly writerConfig: WriterDbConfig | null;
  private readerPool: mysql.Pool | null = null;
  private writerPool: mysql.Pool | null = null;

  constructor(readerConfig: HistoryDbConfig, writerConfig?: WriterDbConfig) {
    this.readerConfig = readerConfig;
    this.writerConfig = writerConfig ?? null;
  }

  private createPool(config: HistoryDbConfig | WriterDbConfig): mysql.Pool {
    return mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 3,
      waitForConnections: true,
      charset: "utf8mb4",
      timezone: "+08:00",
    });
  }

  private getReaderPool(): mysql.Pool {
    if (!this.readerPool) {
      this.readerPool = this.createPool(this.readerConfig);
    }
    return this.readerPool;
  }

  private getWriterPool(): mysql.Pool {
    if (!this.writerPool && this.writerConfig) {
      this.writerPool = this.createPool(this.writerConfig);
    }
    // Fallback to reader pool when no dedicated writer is configured.
    return this.writerPool ?? this.getReaderPool();
  }

  /** Fetch a history record by ID. Returns null if not found. */
  async getRecord(historyId: number): Promise<HistoryRecord | null> {
    const pool = this.getReaderPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, session_id, user_id, message, response, tools_used, metadata, created_at
       FROM history_messages WHERE id = ?`,
      [historyId],
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      sessionId: row.session_id ?? "",
      userId: row.user_id ?? "",
      message: row.message ?? "",
      response: row.response ?? null,
      toolsUsed: row.tools_used ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.created_at,
    };
  }

  /** Update the response field for a history record. */
  async updateResponse(historyId: number, response: string): Promise<void> {
    const pool = this.getWriterPool();
    await pool.execute("UPDATE history_messages SET response = ? WHERE id = ?", [
      response,
      historyId,
    ]);
  }

  /**
   * Merge a patch into a record's `metadata` JSON. Independent writers touch
   * different keys — the work-process timeline (`{ steps: [...] }`), citation
   * sources (`{ citations: [...] }`), and the report-generator (`{ report }`) —
   * so this reads the current metadata and spreads the patch over it rather than
   * overwriting, or one writer would clobber another's keys. The read uses the
   * writer pool to avoid reading a stale replica of our own just-written row.
   * The caller passes a plain object; it is serialized here. Best-effort: a
   * failure must never fail the chat turn.
   */
  async updateMetadata(historyId: number, patch: Record<string, unknown>): Promise<void> {
    const pool = this.getWriterPool();
    let existing: Record<string, unknown> = {};
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT metadata FROM history_messages WHERE id = ?",
      [historyId],
    );
    const raw = rows?.[0]?.metadata;
    // mysql2 returns a JSON column as an already-parsed object (the normal
    // case); tolerate a legacy string value too. Missing the object branch made
    // every write clobber the sibling keys — e.g. the later steps write wiped
    // the citations written earlier in the same turn, so history lost footnotes.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      existing = raw as Record<string, unknown>;
    } else if (typeof raw === "string" && raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Corrupt/legacy metadata — start fresh rather than fail the write.
      }
    }
    const merged = { ...existing, ...patch };
    await pool.execute("UPDATE history_messages SET metadata = ? WHERE id = ?", [
      JSON.stringify(merged),
      historyId,
    ]);
  }

  /**
   * Add one run's token/cost accounting to a history row.
   *
   * Accumulates (`col = col + ?`) rather than assigning: a single chat row can
   * be billed twice — once for the conversational turn, and again later when
   * the asynchronously generated report for that same turn finishes — and the
   * second write must not erase the first. `llm_provider`/`llm_model` keep the
   * FIRST writer's value (COALESCE) so the label reflects the conversation
   * itself; the full per-model detail goes to metadata.usage.
   *
   * Throws on failure (including a not-yet-migrated table, rewritten into an
   * actionable message). Callers treat usage accounting as best-effort and must
   * not fail a turn that already answered the user.
   */
  async addUsage(historyId: number, usage: TurnUsageRecord): Promise<void> {
    const pool = this.getWriterPool();
    try {
      await pool.execute(
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
          roundTokens(usage.inputTokens),
          roundTokens(usage.outputTokens),
          roundTokens(usage.cacheReadTokens),
          roundTokens(usage.cacheWriteTokens),
          roundTokens(usage.totalTokens),
          roundCost(usage.inputCost),
          roundCost(usage.outputCost),
          roundCost(usage.cacheReadCost),
          roundCost(usage.cacheWriteCost),
          roundCost(usage.totalCost),
          roundTokens(usage.calls),
          usage.currency,
          usage.provider ?? null,
          usage.model ?? null,
          historyId,
        ],
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === ER_BAD_FIELD_ERROR) {
        throw new Error(
          "history_messages is missing the token/cost columns (input_tokens, output_tokens, " +
            "cache_read_tokens, cache_write_tokens, total_tokens, input_cost, output_cost, " +
            "cache_read_cost, cache_write_cost, total_cost, cost_currency, llm_provider, " +
            "llm_model, llm_calls); add them before usage can be recorded",
          { cause: err },
        );
      }
      throw err;
    }
  }

  /** Close all connection pools. */
  async close(): Promise<void> {
    if (this.readerPool) {
      await this.readerPool.end();
      this.readerPool = null;
    }
    if (this.writerPool) {
      await this.writerPool.end();
      this.writerPool = null;
    }
  }
}
