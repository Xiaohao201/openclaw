import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import { createHistoryPool, execWithRetry, withDbRetry } from "./db-pool.js";
import {
  resolveReportEmailRecipient,
  type ReportEmailRecipient,
} from "./email-recipient-resolver.js";
import type { HistoryDbConfig, ReportTask } from "./types.js";

export class TaskPoller {
  private readonly config: HistoryDbConfig;
  private readonly pollIntervalMs: number;
  private pool: mysql.Pool | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private logger: PluginLogger | null = null;

  constructor(historyDbConfig: HistoryDbConfig, pollIntervalMs = 30000) {
    this.config = historyDbConfig;
    this.pollIntervalMs = pollIntervalMs;
  }

  private async getPool(): Promise<mysql.Pool> {
    if (!this.pool) {
      this.pool = createHistoryPool(this.config, 3);
    }
    return this.pool;
  }

  private retryOpts(label: string): { logger?: PluginLogger; label: string } {
    return { logger: this.logger ?? undefined, label };
  }

  async fetchPendingTasks(limit = 10): Promise<ReportTask[]> {
    const pool = await this.getPool();
    // LIMIT is inlined (sanitized integer): MySQL 8.0.22+ rejects prepared
    // LIMIT params sent by mysql2 as DOUBLE ("Incorrect arguments to
    // mysqld_stmt_execute").
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    // period IN (...) keeps us off legacy-frontend download rows
    // (period IS NULL), which are consumed by the legacy report service.
    const sql = `
      SELECT d.id, d.uid, d.topicId, d.slaveTopicId, d.category, d.period, d.status,
             d.params, d.requirement, d.title, d.content
      FROM download d
      WHERE d.category = 'Report' AND d.status = 'Pending'
        AND d.period IN ('Daily', 'Weekly', 'Monthly')
      ORDER BY d.id ASC
      LIMIT ${safeLimit}
    `;
    const [rows] = await execWithRetry<mysql.RowDataPacket[]>(
      pool,
      sql,
      undefined,
      this.retryOpts("fetchPendingTasks"),
    );
    return rows.map((row) => row as ReportTask);
  }

  /** Fetch a single report task by id (any status). Returns null if not found. */
  async fetchTaskById(id: number): Promise<ReportTask | null> {
    const pool = await this.getPool();
    const sql = `
      SELECT d.id, d.uid, d.topicId, d.slaveTopicId, d.category, d.period, d.status,
             d.params, d.requirement, d.title, d.content
      FROM download d
      WHERE d.id = ? AND d.category = 'Report'
        AND d.period IN ('Daily', 'Weekly', 'Monthly')
      LIMIT 1
    `;
    const [rows] = await execWithRetry<mysql.RowDataPacket[]>(
      pool,
      sql,
      [id],
      this.retryOpts("fetchTaskById"),
    );
    if (rows.length === 0) {
      return null;
    }
    return rows[0] as ReportTask;
  }

  async resolveEmailRecipient(task: ReportTask): Promise<ReportEmailRecipient | null> {
    const pool = await this.getPool();
    return withDbRetry(() => resolveReportEmailRecipient(pool, task), {
      ...this.retryOpts("resolveEmailRecipient"),
    });
  }

  /**
   * Re-pend tasks stuck in Running (crash/restart recovery): a worker that
   * died between claim and completion leaves the row Running forever, which
   * neither the listener nor the poller would ever retry. Generation itself
   * is bounded (~2 min LLM timeout), so anything Running longer than
   * staleMinutes is an orphan.
   */
  async requeueStaleRunning(staleMinutes = 10): Promise<number> {
    const pool = await this.getPool();
    // Inlined (sanitized integer) for the same MySQL 8 prepared-param reason
    // as the LIMIT in fetchPendingTasks.
    const safeMinutes = Math.max(1, Math.min(1440, Math.floor(staleMinutes)));
    // Same period guard as fetchPendingTasks: never re-pend legacy-service
    // rows (period IS NULL) that another consumer may be processing.
    const [result] = await execWithRetry<mysql.ResultSetHeader>(
      pool,
      `UPDATE download SET status = 'Pending', updateDate = NOW()
       WHERE category = 'Report' AND status = 'Running'
         AND period IN ('Daily', 'Weekly', 'Monthly')
         AND updateDate < NOW() - INTERVAL ${safeMinutes} MINUTE`,
      undefined,
      this.retryOpts("requeueStaleRunning"),
    );
    return result.affectedRows;
  }

  /**
   * Atomically claim a Pending task (Pending → Running). Returns false when
   * another worker (listener vs fallback poller) already claimed it.
   */
  async claimTask(id: number): Promise<boolean> {
    const pool = await this.getPool();
    // Not retried: a retry after a dropped-but-committed claim would see the
    // row already Running and report "not claimed", silently orphaning the task.
    // A transient failure here just throws — the next poll re-claims it (still
    // Pending), and requeueStaleRunning rescues any committed-then-lost claim.
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE download SET status = 'Running', updateDate = NOW() WHERE id = ? AND status = 'Pending'",
      [id],
    );
    return result.affectedRows === 1;
  }

  async updateTaskStatus(id: number, status: ReportTask["status"]): Promise<void> {
    const pool = await this.getPool();
    await execWithRetry(
      pool,
      "UPDATE download SET status = ?, updateDate = NOW() WHERE id = ?",
      [status, id],
      this.retryOpts("updateTaskStatus"),
    );
  }

  async updateTaskResult(
    id: number,
    title: string,
    content: string,
    status: ReportTask["status"] = "Done",
  ): Promise<void> {
    const pool = await this.getPool();
    // Idempotent (sets the same row to the same values) → safe to retry, which
    // matters most here: losing this write to a blip discards a generated report.
    await execWithRetry(
      pool,
      "UPDATE download SET status = ?, title = ?, content = ?, updateDate = NOW() WHERE id = ?",
      [status, title, content, id],
      this.retryOpts("updateTaskResult"),
    );
  }

  start(
    logger: PluginLogger,
    pollFn: (task: ReportTask, logger: PluginLogger) => Promise<void>,
  ): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.logger = logger;

    const poll = async () => {
      try {
        const requeued = await this.requeueStaleRunning();
        if (requeued > 0) {
          logger.warn(`[TASK_POLLER] Re-pended ${requeued} stale Running task(s)`);
        }
        const tasks = await this.fetchPendingTasks();
        for (const task of tasks) {
          logger.info(`[TASK_POLLER] Processing task #${task.id}`);
          await pollFn(task, logger);
        }
      } catch (error) {
        logger.error(`[TASK_POLLER] Poll error: ${String(error)}`);
      }
    };

    void poll();
    this.intervalId = setInterval(poll, this.pollIntervalMs);
    logger.info(
      `[TASK_POLLER] Started polling for pending report tasks (interval=${this.pollIntervalMs}ms)`,
    );
  }

  async stop(logger: PluginLogger): Promise<void> {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    logger.info("[TASK_POLLER] Stopped");
  }
}
