import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import type { HistoryDbConfig } from "./types.js";

/**
 * Shared MySQL pool factory + transient-error retry for the report worker.
 *
 * The history DB is restarted often (maintenance / OOM). Two defenses:
 *   1. Pool tuning here — TCP keepalive so dead sockets are detected, and idle
 *      eviction so the pool never hands out a connection that died during a
 *      restart (mysql2 otherwise reuses it once and throws PROTOCOL_CONNECTION_LOST).
 *   2. withDbRetry / execWithRetry — retry idempotent queries through a short
 *      blip instead of failing the whole report task.
 */
export function createHistoryPool(config: HistoryDbConfig, connectionLimit: number): mysql.Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit,
    waitForConnections: true,
    charset: "utf8mb4",
    timezone: "+08:00",
    // --- resilience to frequent MySQL restarts ---
    enableKeepAlive: true, // keep sockets alive so dead ones surface fast
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    maxIdle: connectionLimit, // evict idle connections...
    idleTimeout: 60_000, // ...after 60s, so a post-restart stale conn is never reused
  });
}

const TRANSIENT_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ER_SERVER_SHUTDOWN",
]);

// 1053 server shutdown, 1040 too many connections, 1205/1213 lock wait/deadlock.
const TRANSIENT_ERRNOS = new Set([1053, 1040, 1205, 1213]);

/** True for connection/availability errors worth retrying (not query bugs). */
export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const e = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) {
    return true;
  }
  if (typeof e.errno === "number" && TRANSIENT_ERRNOS.has(e.errno)) {
    return true;
  }
  const msg = typeof e.message === "string" ? e.message : "";
  return /shutdown in progress|closed the connection|connection lost|ECONNRESET/i.test(msg);
}

export interface DbRetryOptions {
  /** Extra attempts after the first try. Default 3 (so up to 4 total). */
  retries?: number;
  /** First backoff step in ms; doubles each retry. Default 500. */
  baseDelayMs?: number;
  logger?: PluginLogger;
  /** Short tag for the retry log line. */
  label?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run an idempotent DB operation, retrying transient connection failures. */
export async function withDbRetry<T>(fn: () => Promise<T>, opts: DbRetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isTransientDbError(error)) {
        throw error;
      }
      const delay = baseDelayMs * 2 ** attempt; // 500ms, 1s, 2s
      opts.logger?.warn(
        `[REPORT_GENERATOR] DB ${opts.label ?? "query"} transient error ` +
          `(attempt ${attempt + 1}/${retries}), retrying in ${delay}ms: ${String(error)}`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/** A single bound SQL parameter value (mysql2's accepted scalar set). */
export type SqlParam = string | number | bigint | boolean | Date | Buffer | Uint8Array | null;

/** pool.execute wrapped in withDbRetry. Pass `undefined` params for a no-placeholder query. */
export async function execWithRetry<T extends mysql.QueryResult>(
  pool: mysql.Pool,
  sql: string,
  params: SqlParam[] | undefined,
  opts: DbRetryOptions = {},
): Promise<[T, mysql.FieldPacket[]]> {
  return withDbRetry<[T, mysql.FieldPacket[]]>(() => pool.execute<T>(sql, params ?? []), opts);
}
