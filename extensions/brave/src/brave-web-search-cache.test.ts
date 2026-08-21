import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistBraveSearchCache,
  resolveBraveSearchCacheDbConfig,
} from "./brave-web-search-cache.js";

const { executeBraveSearchCacheInsertMock } = vi.hoisted(() => ({
  executeBraveSearchCacheInsertMock: vi.fn(async () => {}),
}));

vi.mock("./brave-web-search-cache.runtime.js", () => ({
  executeBraveSearchCacheInsert: executeBraveSearchCacheInsertMock,
}));

const CACHE_DB = {
  host: "db.internal",
  port: 3307,
  user: "cache-writer",
  password: "test-password",
  database: "superworker",
};

describe("Brave web-search MySQL cache", () => {
  beforeEach(() => {
    executeBraveSearchCacheInsertMock.mockClear();
  });

  it("resolves plugin config before compatible environment fallbacks", () => {
    expect(
      resolveBraveSearchCacheDbConfig(
        { cacheDb: CACHE_DB },
        {
          WEBSEARCH_CACHE_MYSQL_HOST: "env-db",
          WEBSEARCH_CACHE_MYSQL_USER: "env-user",
          WEBSEARCH_CACHE_MYSQL_PASSWORD: "env-password",
        },
      ),
    ).toEqual(CACHE_DB);

    expect(
      resolveBraveSearchCacheDbConfig(
        {},
        {
          HISTORY_MYSQL_HOST: "history-db",
          HISTORY_MYSQL_PORT: "3308",
          HISTORY_MYSQL_USER: "history-user",
          HISTORY_MYSQL_PASSWORD: "history-password",
          HISTORY_MYSQL_DATABASE: "history-db-name",
        },
      ),
    ).toEqual({
      host: "history-db",
      port: 3308,
      user: "history-user",
      password: "history-password",
      database: "history-db-name",
    });
  });

  it("returns undefined when persistence has no complete credentials", () => {
    expect(resolveBraveSearchCacheDbConfig({}, {})).toBeUndefined();
    expect(
      resolveBraveSearchCacheDbConfig(
        { cacheDb: { enabled: false } },
        {
          HISTORY_MYSQL_HOST: "history-db",
          HISTORY_MYSQL_USER: "history-user",
          HISTORY_MYSQL_PASSWORD: "history-password",
        },
      ),
    ).toBeUndefined();
    expect(
      resolveBraveSearchCacheDbConfig({ cacheDb: { host: "db", user: "writer" } }, {}),
    ).toBeUndefined();
  });

  it("does nothing when no cache database is configured", async () => {
    await persistBraveSearchCache({
      cacheKey: "brave:web:disabled",
      query: "disabled",
      content: { provider: "brave", results: [] },
      resultCount: 0,
      ttlMs: 60_000,
    });

    expect(executeBraveSearchCacheInsertMock).not.toHaveBeenCalled();
  });

  it("uses the lazy MySQL runtime when no test executor is supplied", async () => {
    await persistBraveSearchCache({
      config: CACHE_DB,
      cacheKey: "brave:web:runtime",
      query: "runtime",
      content: { provider: "brave", results: [] },
      resultCount: 0,
      ttlMs: 60_000,
    });

    expect(executeBraveSearchCacheInsertMock).toHaveBeenCalledWith(
      CACHE_DB,
      expect.stringContaining("INSERT INTO websearch_cache"),
      expect.any(Array),
    );
  });

  it("inserts every normalized Brave response with bounded fields", async () => {
    const execute = vi.fn(async (_sql: string, _values: Array<string | number | Date>) => {});
    const longQuery = `深圳赛百味${"新".repeat(600)}`;
    const results = [
      {
        title: "门店回应",
        url: "https://example.com/report",
        description: "维修人员踩踏操作台",
      },
    ];

    await persistBraveSearchCache(
      {
        config: CACHE_DB,
        cacheKey: `brave:web:${longQuery}:10:all:zh-hans`,
        query: longQuery,
        content: { provider: "brave", count: 1, results },
        resultCount: 1,
        ttlMs: 15 * 60_000,
      },
      { execute },
    );

    expect(execute).toHaveBeenCalledOnce();
    const [sql, values] = execute.mock.calls[0] ?? [];
    expect(sql).toContain("INSERT INTO websearch_cache");
    expect(sql).not.toContain(longQuery);
    expect(values?.[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(Array.from(String(values?.[1]))).toHaveLength(500);
    expect(JSON.parse(String(values?.[2]))).toEqual({ provider: "brave", count: 1, results });
    expect(values?.[3]).toBe(1);
    expect(values?.[4]).toBeInstanceOf(Date);
  });

  it("does not fail web search when MySQL persistence fails", async () => {
    const warn = vi.fn();

    await expect(
      persistBraveSearchCache(
        {
          config: CACHE_DB,
          cacheKey: "brave:web:test",
          query: "test",
          content: { provider: "brave", count: 0, results: [] },
          resultCount: 0,
          ttlMs: 60_000,
        },
        {
          execute: vi.fn(async () => {
            throw new Error("database unavailable with password=secret");
          }),
          warn,
        },
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[BRAVE] Failed to persist web-search results to websearch_cache",
    );
  });

  it("also contains serialization failures inside the best-effort boundary", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const execute = vi.fn(async () => {});
    const warn = vi.fn();

    await expect(
      persistBraveSearchCache(
        {
          config: CACHE_DB,
          cacheKey: "brave:web:circular",
          query: "circular",
          content: circular,
          resultCount: 1,
          ttlMs: 60_000,
        },
        { execute, warn },
      ),
    ).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
