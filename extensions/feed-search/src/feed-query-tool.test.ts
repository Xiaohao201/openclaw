import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FULL_READ_THRESHOLD,
  SEARCH_RESULT_CHAR_BUDGET,
  SEARCH_TEXT_FIELD_LIMITS,
} from "./feed-query-fields.js";

const { mockExecuteQuery } = vi.hoisted(() => ({
  mockExecuteQuery: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock("./mysql-client.js", () => ({
  executeQuery: mockExecuteQuery,
  resolveConfig: vi.fn(() => ({
    host: "127.0.0.1",
    port: 3306,
    user: "tester",
    password: "secret",
    database: "superworker",
  })),
}));

const { createFeedQueryToolFactory } = await import("./feed-query-tool.js");

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};
type Tool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function makeApi() {
  return {
    pluginConfig: { mysql: { host: "127.0.0.1" } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

/** legal_user_role su-flag row (the first query the resolver runs). */
function suRow(su: number): unknown[] {
  return [{ su }];
}

/** entity_auth rows: newest grant first. */
function authRows(...pairs: Array<[number, number]>): unknown[] {
  return pairs.map(([masterId, slaveId]) => ({ masterId, slaveId }));
}

function titleRows(...pairs: Array<[number, string]>): unknown[] {
  return pairs.map(([id, title]) => ({ id, title }));
}

describe("createFeedQueryToolFactory", () => {
  let factory: (ctx: Record<string, unknown>) => Tool | null;

  beforeEach(() => {
    factory = createFeedQueryToolFactory(makeApi()) as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses text budgets aligned with the database schema and sampled lengths", () => {
    expect(SEARCH_TEXT_FIELD_LIMITS).toEqual({
      title: 120,
      summary: 300,
      author: 40,
      platform: 16,
      level: 6,
      emotion: 8,
      date: 24,
      link: 320,
      mediaLevel: 10,
      contentType: 7,
      city: 16,
    });
  });

  it("exposes the tool only to rabbitmq-prefixed agents", () => {
    expect(factory({ agentId: "rabbitmq-1749" })).not.toBeNull();
    expect(factory({ agentId: "telegram-bot" })).toBeNull();
    expect(factory({ agentId: "rabbitmq-" })).toBeNull();
    expect(factory({})).toBeNull();
  });

  it("runs a scoped search and returns whitelisted rows", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));
    mockExecuteQuery.mockResolvedValueOnce([{ cnt: 1 }]);
    mockExecuteQuery.mockResolvedValueOnce([
      { id: 1, title: "标题", level: "Red", emotion: "Negative" },
    ]);

    const result = await tool.execute("call-1", { keyword: "裁员" });

    expect(result.details).toMatchObject({
      success: true,
      topic: { topicId: 585, topicName: "广本监测专项" },
      count: 1,
      returnedCount: 1,
      total: 1,
      readMode: "full",
      sampled: false,
    });
    // The auth query must use the trusted userId parsed from agentId.
    expect(mockExecuteQuery).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("FROM entity_auth"),
      ["2005"],
    );
    const countCall = mockExecuteQuery.mock.calls[3];
    expect(countCall[1]).toContain("SELECT COUNT(*) AS cnt");
    const searchCall = mockExecuteQuery.mock.calls[4];
    expect(searchCall[1]).toContain("WHERE f.slaveTopicId = ? AND f.skip = 0");
    expect(searchCall[2]).toEqual([585, "%裁员%", "%裁员%", "%裁员%"]);
  });

  it("returns zero total without running a detail query", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce([{ cnt: 0 }]);

    const result = await tool.execute("call-1", {});

    expect(result.details).toMatchObject({
      success: true,
      total: 0,
      returnedCount: 0,
      count: 0,
      readMode: "full",
      sampled: false,
      items: [],
    });
    expect(mockExecuteQuery).toHaveBeenCalledTimes(4);
  });

  it("reads the complete result at the threshold", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    const rows = Array.from({ length: FULL_READ_THRESHOLD }, (_, index) => ({
      id: index + 1,
      title: `标题 ${index + 1}`,
      summary: "摘要",
      date: "2026-06-01",
    }));
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce([{ cnt: FULL_READ_THRESHOLD }]);
    mockExecuteQuery.mockResolvedValueOnce(rows);

    const result = await tool.execute("call-1", { limit: 5 });

    expect(result.details).toMatchObject({
      total: FULL_READ_THRESHOLD,
      returnedCount: FULL_READ_THRESHOLD,
      count: FULL_READ_THRESHOLD,
      readMode: "full",
      sampled: false,
    });
    expect(mockExecuteQuery.mock.calls[4][1]).toContain(`LIMIT ${FULL_READ_THRESHOLD}`);
  });

  it.each([FULL_READ_THRESHOLD + 1, 1_000_000])(
    "samples a larger result while preserving its exact total (%i)",
    async (total) => {
      const tool = factory({ agentId: "rabbitmq-2005" })!;
      const rows = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        title: `样本 ${index + 1}`,
        date: "2026-06-01",
      }));
      mockExecuteQuery.mockResolvedValueOnce(suRow(0));
      mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
      mockExecuteQuery.mockResolvedValueOnce([{ cnt: total }]);
      mockExecuteQuery.mockResolvedValueOnce(rows);

      const result = await tool.execute("call-1", {});

      expect(result.details).toMatchObject({
        total,
        returnedCount: 100,
        count: 100,
        readMode: "sample",
        sampled: true,
        samplingMethod: "recent-risk-temporal-v1",
      });
      const sampleSql = String(mockExecuteQuery.mock.calls[4][1]);
      expect(sampleSql).toContain("ROW_NUMBER() OVER");
      expect(sampleSql).not.toMatch(/ORDER BY\s+RAND\s*\(/i);
    },
  );

  it("bounds long model-visible rows and reports field truncation", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    const longText = "舆情内容".repeat(2_000);
    const rows = Array.from({ length: FULL_READ_THRESHOLD }, (_, index) => ({
      id: index + 1,
      title: longText,
      summary: longText,
      author: longText,
      platform: "微博",
      level: "Red",
      emotion: "Negative",
      date: "2026-06-01",
      link: `https://example.com/${longText}`,
      mediaLevel: "Government",
      contentType: "Article",
      city: "广州市",
    }));
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce([{ cnt: FULL_READ_THRESHOLD }]);
    mockExecuteQuery.mockResolvedValueOnce(rows);

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text.length).toBeLessThanOrEqual(SEARCH_RESULT_CHAR_BUDGET);
    expect(result.details).toMatchObject({
      returnedCount: FULL_READ_THRESHOLD,
      fieldsTruncated: true,
    });
    expect((result.details.items as unknown[]).length).toBe(FULL_READ_THRESHOLD);
    expect((result.details.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      platform: "微博",
      level: "Red",
      emotion: "Negative",
      date: "2026-06-01",
      mediaLevel: "Government",
      contentType: "Article",
      city: "广州市",
    });
  });

  it("rejects a topicId outside the authorized set without querying data", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

    const result = await tool.execute("call-1", { topicId: 999 });

    expect(result.details.success).toBe(false);
    expect(String(result.details.error)).toContain("999");
    expect(result.details.authorizedTopics).toEqual([{ topicId: 585, topicName: "广本监测专项" }]);
    // su + entity_auth + feed_topic only; the data query never ran.
    expect(mockExecuteQuery).toHaveBeenCalledTimes(3);
  });

  it("returns a friendly error when the user has no authorized topics", async () => {
    const tool = factory({ agentId: "rabbitmq-7" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce([]);

    const result = await tool.execute("call-1", {});

    expect(result.details.success).toBe(false);
    expect(String(result.details.error)).toMatch(/no authorized/i);
  });

  it("rejects malformed dates before touching the data tables", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));

    const result = await tool.execute("call-1", { startDate: "06/01/2026" });

    expect(result.details.success).toBe(false);
    expect(String(result.details.error)).toMatch(/YYYY-MM-DD/);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(3);
  });

  it("aggregates stats with a total and per-dimension buckets", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce([{ cnt: 12 }]);
    mockExecuteQuery.mockResolvedValueOnce([
      { value: "Red", cnt: 2 },
      { value: "Blue", cnt: 10 },
    ]);

    const result = await tool.execute("call-1", { mode: "stats", groupBy: ["level"] });

    expect(result.details).toMatchObject({
      success: true,
      total: 12,
      aggregations: [
        {
          dimension: "level",
          buckets: [
            { value: "Red", count: 2 },
            { value: "Blue", count: 10 },
          ],
        },
      ],
    });
  });

  it("rejects an unauthorized topicId in stats mode as well", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));

    const result = await tool.execute("call-1", { mode: "stats", topicId: 999 });

    expect(result.details.success).toBe(false);
    expect(result.details.authorizedTopics).toEqual([{ topicId: 585, topicName: "广本" }]);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(3);
  });

  it("ignores an LLM-supplied userId parameter; identity comes from agentId only", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce([]);

    await tool.execute("call-1", { userId: "1749" });

    expect(mockExecuteQuery).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("FROM entity_auth"),
      ["2005"],
    );
  });

  it("binds a hostile agentId suffix as a parameter, never into SQL text", async () => {
    const tool = factory({ agentId: "rabbitmq-1'; DROP TABLE entity_auth; --" })!;
    mockExecuteQuery.mockResolvedValueOnce([]);

    await tool.execute("call-1", {});

    const [, sql, params] = mockExecuteQuery.mock.calls[0];
    expect(sql).not.toContain("DROP TABLE");
    expect(params).toEqual(["1'; DROP TABLE entity_auth; --"]);
  });

  it("hides internal errors behind a generic message", async () => {
    const tool = factory({ agentId: "rabbitmq-2005" })!;
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockRejectedValueOnce(new Error("ER_ACCESS_DENIED for user btclaw_reader"));

    const result = await tool.execute("call-1", {});

    expect(result.details.success).toBe(false);
    expect(String(result.details.error)).not.toContain("btclaw_reader");
  });
});
