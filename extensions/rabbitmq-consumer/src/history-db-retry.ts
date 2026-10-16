import type { PluginLogger } from "../api.js";

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ER_SERVER_SHUTDOWN",
  "ER_CON_COUNT_ERROR",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_LOCK_DEADLOCK",
]);
const TRANSIENT_ERRNOS = new Set([1053, 1040, 1205, 1213]);
const MAX_ATTEMPTS = 4;

export type HistoryMetadataWriteContext = {
  userId?: string;
  logger?: Pick<PluginLogger, "warn">;
};

function errorFields(error: unknown): { code: string; transient: boolean } {
  const fields =
    error && typeof error === "object" ? (error as { code?: unknown; errno?: unknown }) : {};
  const code =
    typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code)
      ? fields.code
      : "UNKNOWN";
  return {
    code,
    transient:
      TRANSIENT_CODES.has(code) ||
      (typeof fields.errno === "number" && TRANSIENT_ERRNOS.has(fields.errno)),
  };
}

class HistoryMetadataWriteError extends Error {
  constructor(
    readonly code: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`History metadata write failed: code=${code} attempts=${attempts}`, { cause });
    this.name = "HistoryMetadataWriteError";
  }
}

/** Driver messages may include SQL, host names or user content. Log only bounded diagnostics. */
export function describeHistoryDbError(error: unknown): string {
  return `code=${errorFields(error).code} attempts=${error instanceof HistoryMetadataWriteError ? error.attempts : 1}`;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

/** Only for idempotent metadata field assignments; never wrap a chat turn or usage increment. */
export async function retryHistoryMetadataWrite(
  write: () => Promise<void>,
  context: HistoryMetadataWriteContext & { historyId: number; signal: AbortSignal },
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    context.signal.throwIfAborted();
    try {
      await write();
      return;
    } catch (error) {
      context.signal.throwIfAborted();
      const { code, transient } = errorFields(error);
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw new HistoryMetadataWriteError(code, attempt, error);
      }
      const delayMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      context.logger?.warn(
        `[HISTORY_DB] Retrying metadata write: historyId=${context.historyId} ` +
          `userId=${JSON.stringify(context.userId ?? "unknown")} code=${code} ` +
          `attempt=${attempt}/${MAX_ATTEMPTS} retryInMs=${delayMs}`,
      );
      await waitForRetry(delayMs, context.signal);
    }
  }
}
