import { debugLog } from "../notify/debug.js";

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
  /** Short tag for the retry trace line. */
  label?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an idempotent DB operation, retrying transient connection failures.
 * The history MySQL restarts often (maintenance / OOM); without this a single
 * blip mid-query fails the whole tool call.
 */
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
      debugLog(
        `db ${opts.label ?? "query"} transient error (attempt ${attempt + 1}/${retries}), ` +
          `retrying in ${delay}ms: ${String(error)}`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
