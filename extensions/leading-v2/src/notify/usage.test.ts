import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCollect } = vi.hoisted(() => ({
  mockCollect: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api.js")>()),
  collectSessionTurnUsage: mockCollect,
}));

import type { PluginLogger } from "../../api.js";
import { collectTurnUsage, formatUsage, resolveUsageCurrencyPolicy } from "./usage.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as PluginLogger;
const policy = { currency: "CNY", rate: 7, foreignProviders: ["minimax"] };

const params = {
  sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1:sched",
  agentId: "rabbitmq-1749",
  sinceMs: 1_750_000_000_000,
  policy,
  logger,
};

/** One provider's slice of a turn, shaped like the SDK's collector returns it. */
function model(over: Record<string, unknown> = {}) {
  return {
    provider: "qwen",
    model: "qwen3.6-plus",
    calls: 3,
    input: 1000,
    output: 300,
    cacheRead: 200,
    cacheWrite: 0,
    totalTokens: 1500,
    cost: { input: 0.003, output: 0.006, cacheRead: 0.0001, cacheWrite: 0, total: 0.0091 },
    missingCost: false,
    ...over,
  };
}

function usage(models: ReturnType<typeof model>[]) {
  return {
    calls: models.reduce((n, m) => n + m.calls, 0),
    input: models.reduce((n, m) => n + m.input, 0),
    output: models.reduce((n, m) => n + m.output, 0),
    cacheRead: models.reduce((n, m) => n + m.cacheRead, 0),
    cacheWrite: models.reduce((n, m) => n + m.cacheWrite, 0),
    totalTokens: models.reduce((n, m) => n + m.totalTokens, 0),
    models,
    missingCost: false,
  };
}

afterEach(() => vi.clearAllMocks());

describe("resolveUsageCurrencyPolicy", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.USAGE_COST_CURRENCY;
    delete process.env.USAGE_COST_RATE;
    delete process.env.USAGE_COST_FOREIGN_PROVIDERS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to CNY at rate 7", () => {
    const p = resolveUsageCurrencyPolicy({});
    expect(p.currency).toBe("CNY");
    expect(p.rate).toBe(7);
    expect(p.foreignProviders).toContain("minimax");
  });

  it("prefers the plugin config over env", () => {
    process.env.USAGE_COST_RATE = "6";
    const p = resolveUsageCurrencyPolicy({
      usageCost: { rate: 7.2, foreignProviders: ["openai"] },
    });
    expect(p.rate).toBe(7.2);
    expect(p.foreignProviders).toEqual(["openai"]);
  });

  it("falls back to env when the plugin config says nothing", () => {
    process.env.USAGE_COST_RATE = "6";
    process.env.USAGE_COST_CURRENCY = "USD";
    const p = resolveUsageCurrencyPolicy(undefined);
    expect(p.rate).toBe(6);
    expect(p.currency).toBe("USD");
  });
});

describe("collectTurnUsage", () => {
  it("maps the transcript totals onto a history-row record", async () => {
    mockCollect.mockResolvedValue(usage([model()]));

    const record = await collectTurnUsage(params);

    expect(record).toMatchObject({
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 200,
      totalTokens: 1500,
      totalCost: 0.0091,
      currency: "CNY",
      provider: "qwen",
      model: "qwen3.6-plus",
      calls: 3,
    });
    expect(record?.detail).toMatchObject({ source: "schedule", currency: "CNY", calls: 3 });
  });

  it("converts a foreign-priced provider at the policy rate", async () => {
    mockCollect.mockResolvedValue(
      usage([
        model({
          provider: "minimax",
          model: "minimax-m2",
          cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        }),
      ]),
    );

    const record = await collectTurnUsage(params);

    expect(record?.totalCost).toBe(7); // 1 USD × 7
    expect(record?.currency).toBe("CNY");
  });

  it("labels the row with the costliest model when several ran", async () => {
    mockCollect.mockResolvedValue(
      usage([
        model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }),
        model({
          provider: "doubao",
          model: "doubao-seed",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
        }),
      ]),
    );

    const record = await collectTurnUsage(params);

    expect(record?.provider).toBe("doubao");
    expect(record?.calls).toBe(6); // summed across both models
  });

  it("retries once, then gives up, when the transcript has not settled", async () => {
    mockCollect.mockResolvedValue(usage([]));

    const record = await collectTurnUsage(params);

    expect(record).toBeUndefined();
    expect(mockCollect).toHaveBeenCalledTimes(2);
  });

  it("returns undefined instead of throwing when collection blows up", async () => {
    mockCollect.mockRejectedValue(new Error("transcript gone"));
    await expect(collectTurnUsage(params)).resolves.toBeUndefined();
  });
});

describe("formatUsage", () => {
  it("renders a one-line audit trail", async () => {
    mockCollect.mockResolvedValue(usage([model()]));
    const record = await collectTurnUsage(params);
    const line = formatUsage(record!);
    expect(line).toContain("calls=3");
    expect(line).toContain("in=1000");
    expect(line).toContain("CNY");
    expect(line).toContain("qwen/qwen3.6-plus");
  });
});
