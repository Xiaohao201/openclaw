import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

/**
 * Deployment diagnostic transcript: one directory per session, one JSONL file
 * per external run, and one input/output record per model call in the tool loop.
 */
type SessionStepRecord = {
  ts: string;
  startedAt: string;
  stage: "model-step";
  step: number;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  inputSource: "wire-payload" | "context-fallback";
  input?: unknown;
  output?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  error?: string;
};

type StreamResultCarrier = {
  result: () => Promise<AgentMessage>;
};

const writers = new Map<string, QueuedFileWriter>();
const stepCounters = new WeakMap<QueuedFileWriter, number>();
const log = createSubsystemLogger("agent/session-step-log");
const MAX_ACTIVE_RUN_WRITERS = 512;

function safePathSegment(value: string, fallback: string): string {
  const sanitized = Array.from(value.trim(), (character) =>
    character.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(character) ? "_" : character,
  )
    .join("")
    .replace(/^\.+/, "_")
    .slice(0, 160);
  return sanitized || fallback;
}

function getWriter(filePath: string): QueuedFileWriter {
  const existing = writers.get(filePath);
  if (existing) {
    // Refresh insertion order so the bounded cache evicts inactive runs first.
    writers.delete(filePath);
    writers.set(filePath, existing);
    return existing;
  }
  if (writers.size >= MAX_ACTIVE_RUN_WRITERS) {
    const oldestPath = writers.keys().next().value;
    if (typeof oldestPath === "string") {
      writers.delete(oldestPath);
    }
  }
  return getQueuedFileWriter(writers, filePath);
}

export function resolveSessionStepLogPath(params: {
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  runId: string;
  sessionFile?: string;
}): string {
  const env = params.env ?? process.env;
  const rootOverride = env.OPENCLAW_SESSION_STEP_LOG_DIR?.trim();
  const rootDir = rootOverride
    ? resolveUserPath(rootOverride)
    : params.sessionFile
      ? path.dirname(path.resolve(params.sessionFile))
      : path.join(resolveStateDir(env), "logs", "session-steps");
  const sessionDir = safePathSegment(params.sessionId, "unknown-session");
  const runFile = `${safePathSegment(params.runId, "unknown-run")}.jsonl`;
  return path.join(rootDir, sessionDir, runFile);
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error) ?? "unknown error";
  }
  return undefined;
}

function nextStep(writer: QueuedFileWriter): number {
  const step = (stepCounters.get(writer) ?? 0) + 1;
  stepCounters.set(writer, step);
  return step;
}

export type SessionStepLogger = {
  enabled: true;
  filePath: string;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createSessionStepLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  sessionFile?: string;
  writer?: QueuedFileWriter;
}): SessionStepLogger | null {
  const env = params.env ?? process.env;
  if (!(parseBooleanValue(env.OPENCLAW_SESSION_STEP_LOG) ?? false)) {
    return null;
  }

  const filePath = resolveSessionStepLogPath({
    env,
    sessionId: params.sessionId,
    runId: params.runId,
    sessionFile: params.sessionFile,
  });
  const writer = params.writer ?? getWriter(filePath);
  const prepare = (value: unknown): unknown => sanitizeDiagnosticPayload(value);
  const base: Omit<
    SessionStepRecord,
    "ts" | "startedAt" | "stage" | "step" | "inputSource" | "input"
  > = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
  };

  const record = (entry: SessionStepRecord) => {
    const line = safeJsonStringify(entry);
    if (line) {
      writer.write(`${line}\n`);
    }
  };

  const wrapStreamFn: SessionStepLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const startedAt = new Date().toISOString();
      const step = nextStep(writer);
      let capturedInput: unknown;
      let payloadSeen = false;
      let recorded = false;

      const nextOnPayload = (payload: unknown, payloadModel: Model<Api>) => {
        try {
          capturedInput = prepare(payload);
          payloadSeen = true;
        } catch (error) {
          log.debug("session step input capture failed", { error: formatError(error) });
        }
        return options?.onPayload?.(payload, payloadModel);
      };

      const fallbackInput = (): unknown => {
        const fallback = context as {
          systemPrompt?: unknown;
          messages?: unknown;
          thinking?: unknown;
          reasoning?: unknown;
        };
        return prepare({
          systemPrompt: fallback.systemPrompt,
          messages: fallback.messages,
          thinking: fallback.thinking,
          reasoning: fallback.reasoning,
        });
      };

      const writeStep = (assistant?: AgentMessage, error?: unknown) => {
        if (recorded) {
          return;
        }
        recorded = true;
        const output = assistant as { usage?: unknown; stopReason?: unknown } | undefined;
        record({
          ...base,
          ts: new Date().toISOString(),
          startedAt,
          stage: "model-step",
          step,
          inputSource: payloadSeen ? "wire-payload" : "context-fallback",
          input: payloadSeen ? capturedInput : fallbackInput(),
          output: assistant ? prepare(assistant) : undefined,
          usage: output?.usage,
          stopReason: output?.stopReason,
          error: formatError(error),
        });
      };

      const wrapStream = (stream: Awaited<ReturnType<StreamFn>>) => {
        const carrier = stream as unknown as StreamResultCarrier;
        const originalResult = carrier.result.bind(carrier);
        carrier.result = async () => {
          try {
            const message = await originalResult();
            writeStep(message);
            return message;
          } catch (error) {
            writeStep(undefined, error);
            throw error;
          }
        };
        return stream;
      };

      try {
        const maybeStream = streamFn(model, context, { ...options, onPayload: nextOnPayload });
        if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
          return Promise.resolve(maybeStream).then(wrapStream, (error) => {
            writeStep(undefined, error);
            throw error;
          });
        }
        return wrapStream(maybeStream);
      } catch (error) {
        writeStep(undefined, error);
        throw error;
      }
    };
    return wrapped;
  };

  log.info("session step logger enabled", { filePath });
  return { enabled: true, filePath, wrapStreamFn };
}
