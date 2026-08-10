import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../client/db-client.js", () => ({ execute: mockExecute }));

import type { PluginLogger } from "../../api.js";
import type { MySqlConfig } from "../client/types.js";
import { insertHistoryRow, resetUsageColumnSupport, sessionIdFromKey } from "./history-row.js";
import type { TurnUsageRecord } from "./usage.js";

const db = {
  host: "h",
  port: 3306,
  user: "u",
  password: "p",
  database: "superworker",
} as MySqlConfig;

const usage: TurnUsageRecord = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 8000,
  cacheWriteTokens: 0,
  totalTokens: 9540,
  inputCost: 0.0036,
  outputCost: 0.00408,
  cacheReadCost: 0.0024,
  cacheWriteCost: 0,
  totalCost: 0.01008,
  currency: "CNY",
  provider: "qwen",
  model: "qwen3.6-plus",
  calls: 4,
  detail: { currency: "CNY", calls: 4, source: "schedule", outcome: "ok" },
};

const row = { sessionId: "session_9_z", uid: "1749", response: "早安" };

beforeEach(() => resetUsageColumnSupport());
afterEach(() => vi.clearAllMocks());

describe("sessionIdFromKey", () => {
  it("extracts the session_ tail", () => {
    expect(sessionIdFromKey("agent:rabbitmq-1749:rabbitmq:1749:session_123_abc")).toBe(
      "session_123_abc",
    );
    expect(sessionIdFromKey("agent:rabbitmq-1749:rabbitmq:1749:nope")).toBeUndefined();
    expect(sessionIdFromKey(undefined)).toBeUndefined();
  });
});

describe("insertHistoryRow", () => {
  it("writes a plain assistant row when the run was not billed", async () => {
    mockExecute.mockResolvedValue({ insertId: 9 });
    await insertHistoryRow(db, row);

    const [, sql, params] = mockExecute.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("INSERT INTO history_messages");
    expect(sql).not.toContain("total_tokens");
    expect(params).toEqual(["session_9_z", "1749", "早安", null]);
  });

  it("writes the token/cost columns and metadata.usage when the run was billed", async () => {
    mockExecute.mockResolvedValue({ insertId: 9 });
    await insertHistoryRow(db, { ...row, usage });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockExecute.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("total_tokens");
    expect(sql).toContain("cost_currency");
    expect(JSON.parse(String(params[3]))).toEqual({ usage: usage.detail });
    expect(params.slice(4, 9)).toEqual([1200, 340, 8000, 0, 9540]);
    expect(params.slice(9, 14)).toEqual([0.0036, 0.00408, 0.0024, 0, 0.01008]);
    expect(params.slice(14)).toEqual(["CNY", "qwen", "qwen3.6-plus", 4]);
  });

  it("keeps an accounting-only row out of the chat by leaving the response empty", async () => {
    mockExecute.mockResolvedValue({ insertId: 9 });
    await insertHistoryRow(db, { ...row, response: "", usage });

    const [, sql, params] = mockExecute.mock.calls[0] as [unknown, string, unknown[]];
    // message is hardcoded empty (kind=schedule) and response is empty too, so
    // the history loader emits neither bubble.
    expect(sql).toContain("VALUES (?, ?, '', ?, NULL, ?, NOW()");
    expect(params[2]).toBe("");
  });

  it("falls back to the plain insert (warning once) when the table lacks the columns", async () => {
    const warn = vi.fn();
    const logger = { info() {}, warn, error() {}, debug() {} } as unknown as PluginLogger;
    mockExecute
      .mockRejectedValueOnce(
        Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }),
      )
      .mockResolvedValue({ insertId: 9 });

    await insertHistoryRow(db, { ...row, usage }, logger);

    expect(warn).toHaveBeenCalledTimes(1);
    const [, retrySql, retryParams] = mockExecute.mock.calls[1] as [unknown, string, unknown[]];
    expect(retrySql).not.toContain("total_tokens");
    expect(retryParams).toHaveLength(4);

    // Latched: the next row skips the usage attempt entirely.
    mockExecute.mockClear();
    await insertHistoryRow(db, { ...row, usage }, logger);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(String(mockExecute.mock.calls[0][1])).not.toContain("total_tokens");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-schema insert failure instead of double-inserting", async () => {
    mockExecute.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ECONNRESET" }));
    await expect(insertHistoryRow(db, { ...row, usage })).rejects.toThrow("gone");
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
