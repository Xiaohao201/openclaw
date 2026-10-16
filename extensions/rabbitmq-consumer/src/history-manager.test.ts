import mysql from "mysql2/promise";
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

describe("HistoryManager.updateMetadata", () => {
  let manager: InstanceType<typeof HistoryManager>;

  beforeEach(() => {
    mockExecute.mockReset();
    manager = new HistoryManager(DB_CONFIG);
  });

  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("recycles idle connections before reusing a stale socket", async () => {
    mockExecute.mockResolvedValue([[], undefined]);
    await manager.updateMetadata(42, { steps: [] });
    expect(mysql.createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionLimit: 3,
        maxIdle: 2,
        idleTimeout: 60_000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
        connectTimeout: 10_000,
      }),
    );
  });

  it("updates only supplied JSON fields in one atomic statement with bound values", async () => {
    mockExecute.mockResolvedValue([[], undefined]);
    const key = 'quoted".field';
    const value = { text: "O'Reilly", list: [1, null, false] };
    await manager.updateMetadata(42, { [key]: value, nullable: null });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain("JSON_SET(");
    expect(sql).toContain("JSON_VALID(metadata)");
    expect(sql).not.toContain(key);
    expect(sql).not.toContain(value.text);
    expect(params).toEqual([
      `$.${JSON.stringify(key)}`,
      JSON.stringify(value),
      '$."nullable"',
      "null",
      42,
    ]);
  });

  it("normalizes legacy metadata on the writer without reading or overwriting sibling fields", async () => {
    mockExecute.mockResolvedValue([[], undefined]);
    await manager.updateMetadata(42, { steps: [] });
    expect(mockExecute).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "CASE WHEN JSON_VALID(metadata) THEN CASE WHEN JSON_TYPE(metadata) = 'OBJECT' THEN metadata ELSE JSON_OBJECT() END ELSE JSON_OBJECT() END",
      ),
      ['$."steps"', "[]", 42],
    );
    expect(mockExecute.mock.calls[0][0]).not.toContain("SELECT");
  });

  it("does not issue a query for an empty patch or unsupported JSON values", async () => {
    await manager.updateMetadata(42, {});
    await manager.updateMetadata(42, { omitted: undefined });
    await expect(manager.updateMetadata(42, { invalid: BigInt(1) })).rejects.toThrow();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("keeps a retry ahead of the same row's terminal state while other rows can progress", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockExecute.mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    mockExecute.mockResolvedValue([[], undefined]);
    const patch = { steps: [{ status: "running" }] };
    const running = manager.updateMetadata(42, patch);
    patch.steps[0].status = "mutated";
    const terminal = manager.updateMetadata(42, { steps: [{ status: "completed" }] });
    const other = manager.updateMetadata(43, { citations: [] });
    await vi.advanceTimersByTimeAsync(0);
    await other;
    expect(mockExecute).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    await Promise.all([running, terminal]);
    const params = mockExecute.mock.calls.map((call) => call[1] as unknown[]);
    expect(params.map((values) => values.at(-1))).toEqual([42, 43, 42, 42]);
    expect(params[0]).toEqual(params[2]);
    expect(params[0][1]).toBe('[{"status":"running"}]');
    expect(params[3][1]).toBe('[{"status":"completed"}]');
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
  });

  it("allows the next snapshot after retry exhaustion", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    mockExecute.mockRejectedValue(error);
    const failed = manager.updateMetadata(42, { steps: [] }).catch((cause: unknown) => cause);
    await vi.runAllTimersAsync();
    expect(await failed).toMatchObject({ code: "ECONNRESET", attempts: 4 });
    mockExecute.mockResolvedValueOnce([[], undefined]);
    await manager.updateMetadata(42, { steps: [{ status: "completed" }] });
    expect(mockExecute).toHaveBeenCalledTimes(5);
  });

  it("cancels pending retries and queued writes on shutdown without reopening the pool", async () => {
    vi.useFakeTimers();
    mockExecute.mockRejectedValue(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    const first = manager.updateMetadata(42, { steps: [] }).catch((error: unknown) => error);
    const queued = manager.updateMetadata(42, { steps: [] }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await manager.close();
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(await queued).toMatchObject({ name: "AbortError" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(manager.updateMetadata(42, { steps: [] })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
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
      .find((c) => typeof c[0] === "string" && c[0].includes("UPDATE `history_messages`"));
    if (!call) {
      throw new Error("no UPDATE executed");
    }
    return { sql: call[0] as string, params: call[1] as unknown[] };
  }

  beforeEach(() => {
    mockExecute.mockReset();
    manager = new HistoryManager(DB_CONFIG);
  });

  afterEach(async () => {
    await manager.close();
    vi.clearAllMocks();
  });

  it("does not retry a usage increment after an ambiguous connection failure", async () => {
    const error = Object.assign(new Error("reset after commit"), { code: "ECONNRESET" });
    mockExecute.mockRejectedValueOnce(error);
    await expect(manager.addUsage(42, USAGE)).rejects.toBe(error);
    expect(mockExecute).toHaveBeenCalledTimes(1);
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

describe("HistoryManager.queryCollaborationHistory", () => {
  let manager: InstanceType<typeof HistoryManager>;

  beforeEach(() => {
    manager = new HistoryManager(DB_CONFIG);
  });

  afterEach(async () => {
    await manager.close();
    vi.clearAllMocks();
  });

  it("lets a user read only their own rows without an administrator lookup", async () => {
    mockExecute.mockResolvedValueOnce([
      [
        {
          id: 8,
          session_id: "session-a",
          message: "问题",
          response: "回答",
          created_at: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      undefined,
    ]);

    const result = await manager.queryCollaborationHistory({
      requesterUserId: "42",
      targetUserId: "42",
      limit: 20,
    });

    expect(result).toMatchObject({ status: "ok", access: "self", targetUserId: "42" });
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(mockExecute.mock.calls[0]?.[0]).toContain("WHERE user_id = ?");
    expect(mockExecute.mock.calls[0]?.[0]).toMatch(/LIMIT 21\s*$/u);
    expect(mockExecute.mock.calls[0]?.[1]).toEqual(["42"]);
  });

  it("denies cross-user reads before querying history when requester is not an administrator", async () => {
    mockExecute.mockResolvedValueOnce([[{ su: 0 }], undefined]);

    const result = await manager.queryCollaborationHistory({
      requesterUserId: "42",
      targetUserId: "99",
      limit: 20,
    });

    expect(result).toEqual({ status: "forbidden" });
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(mockExecute).toHaveBeenCalledWith("SELECT su FROM legal_user_role WHERE id = ?", ["42"]);
  });

  it("allows a database-confirmed administrator to query another user's rows", async () => {
    mockExecute.mockResolvedValueOnce([[{ su: 1 }], undefined]);
    mockExecute.mockResolvedValueOnce([
      [
        {
          id: 18,
          session_id: "session-b",
          message: "别人的问题",
          response: "别人的回答",
          created_at: new Date("2026-08-02T00:00:00.000Z"),
        },
      ],
      undefined,
    ]);

    const result = await manager.queryCollaborationHistory({
      requesterUserId: "1",
      targetUserId: "99",
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-09-01T00:00:00.000Z",
      beforeId: 30,
      limit: 10,
    });

    expect(result).toMatchObject({
      status: "ok",
      access: "administrator",
      targetUserId: "99",
    });
    expect(mockExecute.mock.calls[1]?.[0]).toContain("created_at >= ?");
    expect(mockExecute.mock.calls[1]?.[0]).toContain("created_at < ?");
    expect(mockExecute.mock.calls[1]?.[0]).toContain("id < ?");
    expect(mockExecute.mock.calls[1]?.[0]).toMatch(/LIMIT 11\s*$/u);
    expect(mockExecute.mock.calls[1]?.[1]).toEqual([
      "99",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      30,
    ]);
  });

  it.each([
    [undefined, 51],
    [0, 2],
    [-5, 2],
    [2.9, 3],
    [1000, 101],
    [Number.NaN, 51],
    [Number.POSITIVE_INFINITY, 51],
  ])("uses a bounded integer SQL limit for %s", async (limit, fetchLimit) => {
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.queryCollaborationHistory({
      requesterUserId: "42",
      targetUserId: "42",
      limit,
    });

    expect(mockExecute.mock.calls[0]?.[0]).toMatch(new RegExp(`LIMIT ${fetchLimit}\\s*$`, "u"));
    expect(mockExecute.mock.calls[0]?.[1]).toEqual(["42"]);
  });

  it("uses the extra row only to detect the next page", async () => {
    mockExecute.mockResolvedValueOnce([
      [8, 7, 6].map((id) => ({
        id,
        session_id: "session-a",
        message: "question",
        response: null,
        created_at: new Date("2026-08-01T00:00:00.000Z"),
      })),
      undefined,
    ]);

    const result = await manager.queryCollaborationHistory({
      requesterUserId: "42",
      targetUserId: "42",
      limit: 2,
    });

    expect(result).toMatchObject({
      status: "ok",
      records: [{ id: 8 }, { id: 7 }],
      hasMore: true,
      nextBeforeId: 7,
    });
  });
});

describe("HistoryManager test-table isolation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates and uses an isolated history table", async () => {
    const manager = new HistoryManager(DB_CONFIG, undefined, "history_test");
    mockExecute.mockRejectedValueOnce(
      Object.assign(new Error("Table does not exist"), { code: "ER_NO_SUCH_TABLE" }),
    );
    mockExecute.mockResolvedValue([[], undefined]);

    await manager.ensureTableLike("history_messages");
    await manager.createRecord({
      historyId: 1_234,
      sessionId: "session-test",
      userId: "user-test",
      message: "测试消息",
      useMemory: true,
      useWebsearch: false,
    });
    await manager.updateResponse(1_234, "测试回答");

    expect(mockExecute.mock.calls.map((call) => call[0])).toEqual([
      "SELECT 1 FROM `history_test` LIMIT 0",
      "CREATE TABLE IF NOT EXISTS `history_test` LIKE `history_messages`",
      expect.stringContaining("INSERT INTO `history_test`"),
      "UPDATE `history_test` SET response = ? WHERE id = ?",
    ]);
    expect(mockExecute.mock.calls[2]?.[1]).toEqual([
      1_234,
      "session-test",
      "user-test",
      "测试消息",
    ]);

    await manager.close();
  });

  it("falls back to the reader connection when the writer cannot create tables", async () => {
    const manager = new HistoryManager(DB_CONFIG, { ...DB_CONFIG, user: "writer" }, "history_test");
    mockExecute.mockRejectedValueOnce(
      Object.assign(new Error("Table does not exist"), { code: "ER_NO_SUCH_TABLE" }),
    );
    mockExecute.mockRejectedValueOnce(
      Object.assign(new Error("CREATE command denied"), {
        code: "ER_TABLEACCESS_DENIED_ERROR",
      }),
    );
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.ensureTableLike("history_messages");

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockExecute.mock.calls[0]?.[0]).toBe("SELECT 1 FROM `history_test` LIMIT 0");
    expect(mockExecute.mock.calls[1]?.[0]).toBe(
      "CREATE TABLE IF NOT EXISTS `history_test` LIKE `history_messages`",
    );
    expect(mockExecute.mock.calls[2]?.[0]).toBe(
      "CREATE TABLE IF NOT EXISTS `history_test` LIKE `history_messages`",
    );
    await manager.close();
  });

  it("does not require CREATE permission after the isolated table already exists", async () => {
    const manager = new HistoryManager(DB_CONFIG, undefined, "history_test");
    mockExecute.mockResolvedValueOnce([[], undefined]);

    await manager.ensureTableLike("history_messages");

    expect(mockExecute).toHaveBeenCalledOnce();
    expect(mockExecute).toHaveBeenCalledWith("SELECT 1 FROM `history_test` LIMIT 0");
    await manager.close();
  });

  it.each(["history-test", "history_test; DROP TABLE skills", "", "1history_test"])(
    "rejects unsafe table identifier %j",
    (tableName) => {
      expect(() => new HistoryManager(DB_CONFIG, undefined, tableName)).toThrow(
        /Invalid MySQL table identifier/,
      );
      expect(mockExecute).not.toHaveBeenCalled();
    },
  );
});
