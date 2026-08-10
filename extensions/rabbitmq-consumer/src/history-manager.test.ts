import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryDbConfig, TurnUsageRecord } from "./types.js";

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn<(...args: unknown[]) => Promise<[unknown[], unknown]>>(),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({
      execute: mockExecute,
      end: vi.fn(async () => {}),
    })),
  },
}));

const { HistoryManager } = await import("./history-manager.js");

const DB_CONFIG: HistoryDbConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "tester",
  password: "secret",
  database: "superworker",
};

/** A metadata SELECT result carrying `raw` in the metadata column. */
function metaRow(raw: unknown): [unknown[], unknown] {
  return [[{ metadata: raw }], undefined];
}

/** Parse the JSON written by the last UPDATE (metadata is the first bind param). */
function lastWrittenMetadata(): Record<string, unknown> {
  const updateCall = mockExecute.mock.calls
    .toReversed()
    .find((c) => typeof c[0] === "string" && c[0].startsWith("UPDATE"));
  if (!updateCall) {
    throw new Error("no UPDATE executed");
  }
  const params = updateCall[1] as unknown[];
  return JSON.parse(params[0] as string) as Record<string, unknown>;
}

describe("HistoryManager.updateMetadata", () => {
  let manager: InstanceType<typeof HistoryManager>;

  beforeEach(() => {
    manager = new HistoryManager(DB_CONFIG);
  });

  afterEach(async () => {
    await manager.close();
    vi.clearAllMocks();
  });

  it("merges into a JSON-object metadata without clobbering sibling keys", async () => {
    // mysql2 returns a JSON column as an already-parsed object. The steps write
    // must preserve the citations written earlier in the same turn — the exact
    // regression that made history lose footnotes.
    mockExecute.mockResolvedValueOnce(metaRow({ citations: [{ id: 1, url: "https://x" }] }));
    mockExecute.mockResolvedValueOnce([[], undefined]); // UPDATE ack

    await manager.updateMetadata(42, { steps: [{ id: "answer" }] });

    const written = lastWrittenMetadata();
    expect(written.citations).toEqual([{ id: 1, url: "https://x" }]);
    expect(written.steps).toEqual([{ id: "answer" }]);
  });

  it("merges into a legacy string metadata value", async () => {
    mockExecute.mockResolvedValueOnce(metaRow(JSON.stringify({ steps: [{ id: "answer" }] })));
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.updateMetadata(42, { citations: [{ id: 1 }] });

    const written = lastWrittenMetadata();
    expect(written.steps).toEqual([{ id: "answer" }]);
    expect(written.citations).toEqual([{ id: 1 }]);
  });

  it("starts fresh when metadata is null", async () => {
    mockExecute.mockResolvedValueOnce(metaRow(null));
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.updateMetadata(42, { citations: [{ id: 1 }] });

    expect(lastWrittenMetadata()).toEqual({ citations: [{ id: 1 }] });
  });

  it("does not treat a JSON array metadata value as a mergeable object", async () => {
    // A stray array must not spread into numeric keys; start fresh instead.
    mockExecute.mockResolvedValueOnce(metaRow([1, 2, 3]));
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.updateMetadata(42, { steps: [] });

    expect(lastWrittenMetadata()).toEqual({ steps: [] });
  });
});

describe("HistoryManager.addUsage", () => {
  let manager: InstanceType<typeof HistoryManager>;

  const USAGE: TurnUsageRecord = {
    inputTokens: 3_000,
    outputTokens: 400,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 0,
    totalTokens: 5_400,
    inputCost: 0.003,
    outputCost: 0.0012,
    cacheReadCost: 0.0004,
    cacheWriteCost: 0,
    totalCost: 0.0046,
    currency: "CNY",
    provider: "qwen",
    model: "qwen3.6-plus",
    calls: 2,
  };

  /** The last UPDATE issued, as [sql, params]. */
  function lastUpdate(): { sql: string; params: unknown[] } {
    const call = mockExecute.mock.calls
      .toReversed()
      .find((c) => typeof c[0] === "string" && c[0].includes("UPDATE history_messages"));
    if (!call) {
      throw new Error("no UPDATE executed");
    }
    return { sql: call[0] as string, params: call[1] as unknown[] };
  }

  beforeEach(() => {
    manager = new HistoryManager(DB_CONFIG);
  });

  afterEach(async () => {
    await manager.close();
    vi.clearAllMocks();
  });

  it("accumulates onto existing values so a later report write cannot erase the chat turn", async () => {
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.addUsage(42, USAGE);

    const { sql, params } = lastUpdate();
    // Every numeric column must add, never assign.
    for (const col of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "total_tokens",
      "input_cost",
      "output_cost",
      "cache_read_cost",
      "cache_write_cost",
      "total_cost",
      "llm_calls",
    ]) {
      expect(sql).toContain(`${col} = COALESCE(${col}, 0) + ?`);
    }
    // Provider/model keep the first writer's value.
    expect(sql).toContain("llm_provider = COALESCE(llm_provider, ?)");
    expect(sql).toContain("llm_model = COALESCE(llm_model, ?)");
    expect(params).toEqual([
      3_000,
      400,
      2_000,
      0,
      5_400,
      0.003,
      0.0012,
      0.0004,
      0,
      0.0046,
      2,
      "CNY",
      "qwen",
      "qwen3.6-plus",
      42,
    ]);
  });

  it("rounds costs to the DECIMAL(16,8) the column stores", async () => {
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.addUsage(42, { ...USAGE, totalCost: 0.123456789123, inputCost: Number.NaN });

    const { params } = lastUpdate();
    expect(params[9]).toBe(0.12345679);
    // A non-finite cost must land as 0, never as NaN (which MySQL rejects).
    expect(params[5]).toBe(0);
  });

  it("sends NULL, not undefined, when the provider/model are unknown", async () => {
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.addUsage(42, { ...USAGE, provider: undefined, model: undefined });

    const { params } = lastUpdate();
    expect(params[12]).toBeNull();
    expect(params[13]).toBeNull();
  });

  it("rewrites a missing-column failure into an actionable hint", async () => {
    mockExecute.mockRejectedValueOnce(
      Object.assign(new Error("Unknown column 'input_tokens'"), { code: "ER_BAD_FIELD_ERROR" }),
    );

    await expect(manager.addUsage(42, USAGE)).rejects.toThrow(/missing the token\/cost columns/);
  });

  it("propagates other DB errors unchanged", async () => {
    mockExecute.mockRejectedValueOnce(
      Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK" }),
    );

    await expect(manager.addUsage(42, USAGE)).rejects.toThrow(/Deadlock found/);
  });
});
