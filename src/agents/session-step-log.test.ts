import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { QueuedFileWriter } from "./queued-file-writer.js";
import {
  createSessionStepLogger,
  resolveSessionStepLogPath,
  type SessionStepLogger,
} from "./session-step-log.js";

const MODEL = {
  id: "test-model",
  provider: "test",
  api: "openai-responses",
} as unknown as Model<Api>;

function makeWriter(lines: string[], filePath = "<memory>"): QueuedFileWriter {
  return {
    filePath,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

function makeStreamFn(options?: { skipPayload?: boolean; fail?: boolean }): StreamFn {
  return ((model, context, streamOptions) => {
    if (!options?.skipPayload) {
      streamOptions?.onPayload?.(
        {
          model: model.id,
          system: "SYSTEM PROMPT TEXT",
          messages: (context as { messages?: unknown }).messages,
          tools: [{ name: "read", description: "read a file" }],
          apiKey: "sk-super-secret",
        },
        model,
      );
    }
    const stream = {
      result: async () => {
        if (options?.fail) {
          throw new Error("boom");
        }
        return {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "step 1: think about it" },
            { type: "text", text: "final answer" },
          ],
          usage: { input: 10, output: 5 },
          stopReason: "stop",
        } as unknown as AgentMessage;
      },
      [Symbol.asyncIterator]: async function* () {},
    };
    return stream as unknown as ReturnType<StreamFn>;
  }) as StreamFn;
}

function makeContext() {
  return {
    systemPrompt: "SYSTEM PROMPT TEXT",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as unknown as Parameters<StreamFn>[1];
}

async function driveOnce(logger: SessionStepLogger, streamFn: StreamFn): Promise<void> {
  const stream = (await logger.wrapStreamFn(streamFn)(MODEL, makeContext(), {})) as unknown as {
    result: () => Promise<AgentMessage>;
  };
  await stream.result();
}

describe("session step log", () => {
  it("is disabled unless deployment logging is enabled", () => {
    expect(
      createSessionStepLogger({
        env: {} as NodeJS.ProcessEnv,
        runId: "run-1",
        sessionId: "sess-1",
        sessionFile: path.join("state", "agents", "main", "sessions", "sess-1.jsonl"),
        writer: makeWriter([]),
      }),
    ).toBeNull();
  });

  it("uses one session folder and one JSONL file per external conversation", () => {
    const sessionFile = path.join(
      path.parse(process.cwd()).root,
      "state",
      "agents",
      "main",
      "sessions",
      "sess-1.jsonl",
    );
    expect(
      resolveSessionStepLogPath({
        env: { OPENCLAW_SESSION_STEP_LOG: "1" } as NodeJS.ProcessEnv,
        sessionId: "sess-1",
        runId: "run-1",
        sessionFile,
      }),
    ).toBe(path.join(path.dirname(sessionFile), "sess-1", "run-1.jsonl"));

    const stateDir = path.join(path.parse(process.cwd()).root, "fallback-state");
    expect(
      resolveSessionStepLogPath({
        env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
        sessionId: "sess-2",
        runId: "run-2",
      }),
    ).toBe(path.join(stateDir, "logs", "session-steps", "sess-2", "run-2.jsonl"));
  });

  it("writes one redacted input/output record per model step", async () => {
    const lines: string[] = [];
    const logger = createSessionStepLogger({
      env: { OPENCLAW_SESSION_STEP_LOG: "1" } as NodeJS.ProcessEnv,
      runId: "run-1",
      sessionId: "sess-1",
      sessionKey: "agent:main:rabbitmq:1:sess-1",
      provider: "test",
      modelId: "test-model",
      modelApi: "openai-responses",
      sessionFile: path.join("state", "sessions", "sess-1.jsonl"),
      writer: makeWriter(lines),
    });
    expect(logger).not.toBeNull();

    await driveOnce(logger as SessionStepLogger, makeStreamFn());
    await driveOnce(logger as SessionStepLogger, makeStreamFn());

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first).toMatchObject({
      stage: "model-step",
      step: 1,
      runId: "run-1",
      sessionId: "sess-1",
      inputSource: "wire-payload",
      stopReason: "stop",
    });
    expect(second.step).toBe(2);
    expect(first.input.system).toBe("SYSTEM PROMPT TEXT");
    expect(first.input.tools[0].name).toBe("read");
    expect(first.input.apiKey).toBeUndefined();
    expect(first.output.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "step 1: think about it" }),
        expect.objectContaining({ type: "text", text: "final answer" }),
      ]),
    );
    expect(first.usage).toEqual({ input: 10, output: 5 });
  });

  it("falls back to the in-memory input and records failed steps", async () => {
    const lines: string[] = [];
    const logger = createSessionStepLogger({
      env: { OPENCLAW_SESSION_STEP_LOG: "1" } as NodeJS.ProcessEnv,
      runId: "run-failure",
      sessionId: "sess-failure",
      sessionFile: path.join("state", "sessions", "sess-failure.jsonl"),
      writer: makeWriter(lines),
    }) as SessionStepLogger;
    const stream = (await logger.wrapStreamFn(makeStreamFn({ skipPayload: true, fail: true }))(
      MODEL,
      makeContext(),
      {},
    )) as unknown as { result: () => Promise<AgentMessage> };

    await expect(stream.result()).rejects.toThrow("boom");
    const record = JSON.parse(lines[0]);
    expect(record.step).toBe(1);
    expect(record.inputSource).toBe("context-fallback");
    expect(record.input.systemPrompt).toBe("SYSTEM PROMPT TEXT");
    expect(record.output).toBeUndefined();
    expect(record.error).toBe("boom");
  });

  it("records failures that happen before a response stream is available", async () => {
    const lines: string[] = [];
    const writer = makeWriter(lines);
    const logger = createSessionStepLogger({
      env: { OPENCLAW_SESSION_STEP_LOG: "1" } as NodeJS.ProcessEnv,
      runId: "run-transport-errors",
      sessionId: "sess-transport-errors",
      writer,
    }) as SessionStepLogger;
    const syncFailure = (() => {
      throw new Error("sync transport failure");
    }) as StreamFn;
    expect(() => logger.wrapStreamFn(syncFailure)(MODEL, makeContext(), {})).toThrow(
      "sync transport failure",
    );

    const asyncFailure = (() => Promise.reject(new Error("async transport failure"))) as StreamFn;
    await expect(logger.wrapStreamFn(asyncFailure)(MODEL, makeContext(), {})).rejects.toThrow(
      "async transport failure",
    );

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ step: 1, error: "sync transport failure" }),
      expect.objectContaining({ step: 2, error: "async transport failure" }),
    ]);
  });

  it("keeps session and run identifiers inside their intended directory", () => {
    const rootDir = path.join(path.parse(process.cwd()).root, "step-logs");
    const resolved = resolveSessionStepLogPath({
      env: {
        OPENCLAW_SESSION_STEP_LOG: "1",
        OPENCLAW_SESSION_STEP_LOG_DIR: rootDir,
      } as NodeJS.ProcessEnv,
      sessionId: "../../session",
      runId: "../run",
    });
    expect(path.relative(rootDir, resolved).startsWith("..")).toBe(false);
    expect(path.extname(resolved)).toBe(".jsonl");
  });
});
