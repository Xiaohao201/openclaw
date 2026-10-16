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

export type HistoryDbContext = {
  userId?: string;
  logger?: Pick<PluginLogger, "warn">;
};

export type HistoryDbOperation = "getRecord" | "updateResponse" | "updateMetadata";

function errorFields(error: unknown, depth = 0): { code: string; transient: boolean } {
  const fields =
    error && typeof error === "object"
      ? (error as { code?: unknown; errno?: unknown; cause?: unknown })
      : {};
  const code =
    typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code)
      ? fields.code
      : "UNKNOWN";
  if (code === "UNKNOWN" && fields.cause && depth < 3) {
    return errorFields(fields.cause, depth + 1);
  }
  return {
    code,
    transient:
      TRANSIENT_CODES.has(code) ||
      (typeof fields.errno === "number" && TRANSIENT_ERRNOS.has(fields.errno)),
  };
}

export class HistoryDbOperationError extends Error {
  constructor(
    readonly operation: HistoryDbOperation,
    readonly code: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `History database operation failed: operation=${operation} code=${code} attempts=${attempts}`,
      { cause },
    );
    this.name = "HistoryDbOperationError";
  }
}

/** Driver messages may include SQL, host names or user content. Log only bounded diagnostics. */
export function describeHistoryDbError(error: unknown): string {
  const diagnostics = `code=${errorFields(error).code} attempts=${error instanceof HistoryDbOperationError ? error.attempts : 1}`;
  return error instanceof HistoryDbOperationError
    ? `${diagnostics} operation=${error.operation}`
    : diagnostics;
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

/** Only reads and idempotent assignments; never wrap an INSERT, chat turn or usage increment. */
export async function retryHistoryDbOperation<T>(
  run: () => Promise<T>,
  context: HistoryDbContext & {
    operation: HistoryDbOperation;
    historyId: number;
    signal: AbortSignal;
  },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    context.signal.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      context.signal.throwIfAborted();
      const { code, transient } = errorFields(error);
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw new HistoryDbOperationError(context.operation, code, attempt, error);
      }
      const delayMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      context.logger?.warn(
        `[HISTORY_DB] Retrying operation=${context.operation}: historyId=${context.historyId} ` +
          `userId=${JSON.stringify(context.userId ?? "unknown")} code=${code} ` +
          `attempt=${attempt}/${MAX_ATTEMPTS} retryInMs=${delayMs}`,
      );
      await waitForRetry(delayMs, context.signal);
    }
  }
}

export function retryHistoryMetadataWrite(
  write: () => Promise<void>,
  context: HistoryDbContext & { historyId: number; signal: AbortSignal },
): Promise<void> {
  return retryHistoryDbOperation(write, { ...context, operation: "updateMetadata" });
}
