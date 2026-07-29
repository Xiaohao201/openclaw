import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectSessionTurnUsage,
  convertSessionTurnCost,
  mergeSessionTurnUsage,
  primarySessionTurnModel,
  resolveSessionTurnCurrencyPolicy,
  type SessionTurnUsage,
} from "./session-turn-usage.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_KEY = "agent:rabbitmq-42:rabbitmq:42:sess-abc";

let tmpDir: string;
let storePath: string;
let transcriptPath: string;

/** One assistant transcript line as the pi runner writes it. */
function assistantLine(params: {
  atMs: number;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}): string {
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return JSON.stringify({
    timestamp: new Date(params.atMs).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: params.provider,
      model: params.model,
      usage: {
        input: params.input,
        output: params.output,
        cacheRead,
        cacheWrite,
        totalTokens: params.input + params.output + cacheRead + cacheWrite,
        ...(params.cost ? { cost: params.cost } : {}),
      },
      stopReason: "stop",
      timestamp: params.atMs,
    },
  });
}

function writeTranscript(lines: string[]): void {
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-usage-"));
  storePath = path.join(tmpDir, "sessions.json");
  transcriptPath = path.join(tmpDir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(
    storePath,
    JSON.stringify({ [SESSION_KEY.toLowerCase()]: { sessionId: SESSION_ID } }),
    "utf8",
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectSessionTurnUsage", () => {
  it("sums every model call inside the turn window and ignores earlier turns", async () => {
    const turnStart = 1_700_000_000_000;
    writeTranscript([
      // Previous turn in the same session — must not be billed to this one.
      assistantLine({
        atMs: turnStart - 60_000,
        provider: "qwen",
        model: "qwen3.6-plus",
        input: 9_999,
        output: 9_999,
        cost: { input: 9.999, output: 29.997, cacheRead: 0, cacheWrite: 0, total: 39.996 },
      }),
      // This turn: two calls, because a tool result triggered a second one.
      assistantLine({
        atMs: turnStart + 1_000,
        provider: "qwen",
        model: "qwen3.6-plus",
        input: 1_000,
        output: 100,
        cacheRead: 500,
        cost: { input: 0.001, output: 0.0003, cacheRead: 0.0001, cacheWrite: 0, total: 0.0014 },
      }),
      assistantLine({
        atMs: turnStart + 5_000,
        provider: "qwen",
        model: "qwen3.6-plus",
        input: 2_000,
        output: 300,
        cacheRead: 1_500,
        cost: { input: 0.002, output: 0.0009, cacheRead: 0.0003, cacheWrite: 0, total: 0.0032 },
      }),
    ]);

    const usage = await collectSessionTurnUsage({
      sessionKey: SESSION_KEY,
      sinceMs: turnStart,
      storePath,
    });

    expect(usage.calls).toBe(2);
    expect(usage.input).toBe(3_000);
    expect(usage.output).toBe(400);
    expect(usage.cacheRead).toBe(2_000);
    expect(usage.cacheWrite).toBe(0);
    expect(usage.totalTokens).toBe(5_400);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0].cost.total).toBeCloseTo(0.0046, 8);
    expect(usage.missingCost).toBe(false);
  });

  it("prices calls from configured unit prices when the provider reports no cost", async () => {
    const turnStart = 1_700_000_000_000;
    writeTranscript([
      assistantLine({
        atMs: turnStart + 1_000,
        provider: "qwen",
        model: "qwen3.6-plus",
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
      }),
    ]);

    const usage = await collectSessionTurnUsage({
      sessionKey: SESSION_KEY,
      sinceMs: turnStart,
      storePath,
      config: {
        models: {
          providers: {
            qwen: {
              models: [
                {
                  id: "qwen3.6-plus",
                  cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as never,
    });

    expect(usage.calls).toBe(1);
    // 1M tokens at each configured per-million rate.
    expect(usage.models[0].cost.input).toBeCloseTo(1, 8);
    expect(usage.models[0].cost.output).toBeCloseTo(3, 8);
    expect(usage.models[0].cost.cacheRead).toBeCloseTo(0.2, 8);
    expect(usage.models[0].cost.total).toBeCloseTo(4.2, 8);
    expect(usage.missingCost).toBe(false);
  });

  it("flags missing pricing instead of silently billing zero", async () => {
    const turnStart = 1_700_000_000_000;
    writeTranscript([
      assistantLine({
        atMs: turnStart + 1_000,
        provider: "unknown-vendor",
        model: "mystery-1",
        input: 1_000,
        output: 100,
      }),
    ]);

    const usage = await collectSessionTurnUsage({
      sessionKey: SESSION_KEY,
      sinceMs: turnStart,
      storePath,
    });

    expect(usage.calls).toBe(1);
    expect(usage.input).toBe(1_000);
    expect(usage.missingCost).toBe(true);
    expect(usage.models[0].cost.total).toBe(0);
  });

  it("skips zero-token bookkeeping rows (delivery mirrors)", async () => {
    const turnStart = 1_700_000_000_000;
    writeTranscript([
      assistantLine({
        atMs: turnStart + 1_000,
        provider: "openclaw",
        model: "delivery-mirror",
        input: 0,
        output: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ]);

    const usage = await collectSessionTurnUsage({
      sessionKey: SESSION_KEY,
      sinceMs: turnStart,
      storePath,
    });

    expect(usage.calls).toBe(0);
    expect(usage.models).toHaveLength(0);
  });

  it("returns zeroed usage when the session is unknown", async () => {
    const usage = await collectSessionTurnUsage({
      sessionKey: "agent:nobody:none",
      sinceMs: 0,
      storePath,
    });
    expect(usage.calls).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  it("keeps separate buckets per model when a turn switches models", async () => {
    const turnStart = 1_700_000_000_000;
    writeTranscript([
      assistantLine({
        atMs: turnStart + 1_000,
        provider: "qwen",
        model: "qwen3.6-plus",
        input: 100,
        output: 10,
        cost: { input: 0.0001, output: 0.00003, cacheRead: 0, cacheWrite: 0, total: 0.00013 },
      }),
      assistantLine({
        atMs: turnStart + 2_000,
        provider: "minimax",
        model: "MiniMax-M2.7",
        input: 200,
        output: 20,
        cost: { input: 0.00006, output: 0.000024, cacheRead: 0, cacheWrite: 0, total: 0.000084 },
      }),
    ]);

    const usage = await collectSessionTurnUsage({
      sessionKey: SESSION_KEY,
      sinceMs: turnStart,
      storePath,
    });

    expect(usage.calls).toBe(2);
    expect(usage.models.map((m) => m.provider)).toEqual(["minimax", "qwen"]);
  });
});

describe("convertSessionTurnCost", () => {
  const usage = (): SessionTurnUsage => ({
    calls: 2,
    input: 300,
    output: 30,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 330,
    missingCost: false,
    models: [
      {
        provider: "qwen",
        model: "qwen3.6-plus",
        calls: 1,
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        missingCost: false,
      },
      {
        provider: "MiniMax",
        model: "MiniMax-M2.7",
        calls: 1,
        input: 200,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 220,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        missingCost: false,
      },
    ],
  });

  it("applies the rate only to foreign-priced providers", () => {
    const cost = convertSessionTurnCost(usage(), {
      currency: "CNY",
      rate: 7,
      foreignProviders: ["minimax"],
    });
    // qwen already CNY (3) + minimax USD 2 * 7 = 14 -> 17
    expect(cost.total).toBeCloseTo(17, 8);
    expect(cost.input).toBeCloseTo(1 + 1 * 7, 8);
    expect(cost.currency).toBe("CNY");
  });

  it("matches provider ids case-insensitively", () => {
    const cost = convertSessionTurnCost(usage(), {
      currency: "CNY",
      rate: 7,
      foreignProviders: ["MINIMAX"],
    });
    expect(cost.total).toBeCloseTo(17, 8);
  });

  it("leaves costs untouched when no provider is foreign", () => {
    const cost = convertSessionTurnCost(usage(), {
      currency: "CNY",
      rate: 7,
      foreignProviders: [],
    });
    expect(cost.total).toBeCloseTo(5, 8);
  });
});

describe("resolveSessionTurnCurrencyPolicy", () => {
  it("defaults to CNY at rate 7 with a built-in USD vendor list", () => {
    const policy = resolveSessionTurnCurrencyPolicy(undefined);
    expect(policy.currency).toBe("CNY");
    expect(policy.rate).toBe(7);
    expect(policy.foreignProviders).toContain("minimax");
    expect(policy.foreignProviders).not.toContain("qwen");
  });

  it("accepts overrides, including a comma-separated provider list", () => {
    const policy = resolveSessionTurnCurrencyPolicy({
      currency: "USD",
      rate: "0.14",
      foreignProviders: "qwen, deepseek",
    });
    expect(policy).toEqual({
      currency: "USD",
      rate: 0.14,
      foreignProviders: ["qwen", "deepseek"],
    });
  });

  it("falls back to defaults on malformed values", () => {
    const policy = resolveSessionTurnCurrencyPolicy({
      rate: -3,
      currency: "  ",
      foreignProviders: [],
    });
    expect(policy.currency).toBe("CNY");
    expect(policy.rate).toBe(7);
    expect(policy.foreignProviders.length).toBeGreaterThan(0);
  });
});

describe("mergeSessionTurnUsage / primarySessionTurnModel", () => {
  const part = (provider: string, tokens: number, cost: number): SessionTurnUsage => ({
    calls: 1,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    missingCost: false,
    models: [
      {
        provider,
        model: `${provider}-model`,
        calls: 1,
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        missingCost: false,
      },
    ],
  });

  it("re-merges buckets for a model used by several runs", () => {
    const merged = mergeSessionTurnUsage([part("qwen", 100, 1), part("qwen", 50, 0.5), null]);
    expect(merged.calls).toBe(2);
    expect(merged.totalTokens).toBe(150);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0].cost.total).toBeCloseTo(1.5, 8);
  });

  it("picks the costliest model as the turn's primary", () => {
    const merged = mergeSessionTurnUsage([part("qwen", 10, 5), part("minimax", 900, 1)]);
    expect(primarySessionTurnModel(merged)?.provider).toBe("qwen");
  });
});
