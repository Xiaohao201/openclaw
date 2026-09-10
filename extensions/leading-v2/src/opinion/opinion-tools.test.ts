import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const {
  createFeedListToolFactory,
  createTopicListToolFactory,
  createFeedReanalyzeToolFactory,
  createMonthlyStatsToolFactory,
} = await import("./opinion-read-tools.js");

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com", siteId: "legal" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

function parse(result: unknown): Record<string, unknown> {
  const r = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (r?.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => vi.clearAllMocks());

describe("gating", () => {
  it("hides monitoring tools from non-rabbitmq agents", () => {
    for (const factory of [
      createFeedListToolFactory,
      createTopicListToolFactory,
      createFeedReanalyzeToolFactory,
      createMonthlyStatsToolFactory,
    ]) {
      expect(factory(fakeApi, resolver)({ agentId: "coding" })).toBeNull();
    }
  });
});

describe("feed_list", () => {
  it("requires topicId and forwards array filters", async () => {
    const tool = createFeedListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("f0", {})).success).toBe(false);

    mockGetJson.mockResolvedValue({
      total: 1,
      list: [
        {
          id: 5,
          title: "标题",
          platform: "微信",
          emotion: "Negative",
          level: "Red",
          summary: "摘要",
          link: "u",
          date: "d",
        },
      ],
    });
    const res = parse(
      await tool.execute("f1", {
        topicId: 553,
        platforms: ["weixin", "weibo"],
        riskLevels: ["Red"],
      }),
    );
    const [, path, params] = mockGetJson.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/pub-opinion/fetch-feeds");
    expect(params).toMatchObject({ topicId: 553 });
    expect(params.platforms).toEqual(["weixin", "weibo"]);
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 5, level: "Red" });
  });
});

describe("topic_list", () => {
  it("maps schemes and flags dos as not-authorized", async () => {
    const tool = createTopicListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValueOnce({ dos: 1, message: "" });
    expect(parse(await tool.execute("t0", { reportId: "SLUG" })).success).toBe(false);

    mockGetJson.mockResolvedValueOnce({
      code: "success",
      list: [{ id: 7, refId: 0, title: "主方案", master: 1, enableAnalysis: 1 }],
    });
    const res = parse(await tool.execute("t1", { reportId: 1024 }));
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({
      topicId: 7,
      master: true,
      enableAnalysis: true,
    });
  });
});

describe("feed_reanalyze", () => {
  it("validates inputs and maps ruleTypes to variant keys", async () => {
    const tool = createFeedReanalyzeToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    expect(
      parse(
        await tool.execute("r0", {
          topicId: 553,
          reportId: 3965,
          ids: [],
          ruleTypes: ["PreCheck"],
        }),
      ).success,
    ).toBe(false);

    mockPostForm.mockResolvedValue({ code: "success", message: "数据已提交重新分析，请等待：2条" });
    const res = parse(
      await tool.execute("r1", {
        topicId: 553,
        reportId: 3965,
        ids: [1, 2],
        ruleTypes: ["PreCheck", "DoubleCheck"],
        mode: "test",
      }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/pub-opinion/reanalyze-items");
    expect(fields).toMatchObject({
      topicId: 553,
      reportId: 3965,
      preCheck: "test",
      doubleCheck: "test",
    });
    expect(fields.categorize).toBeUndefined();
    expect(fields.ids).toEqual([1, 2]);
    expect(res).toMatchObject({ success: true, submitted: 2 });
  });
});

describe("monthly_stats", () => {
  it("validates months and drops the article-id arrays", async () => {
    const tool = createMonthlyStatsToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("m0", { clusterId: 1, months: ["bad"] })).success).toBe(false);

    mockPostForm.mockResolvedValue({
      code: "success",
      data: [{ time: "01", month: "202510", total: 10, Negative: 2, articles: [1, 2] }],
    });
    const res = parse(await tool.execute("m1", { clusterId: 395804, months: ["202510"] }));
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/pub-opinion/request-monthly-date");
    expect(fields.date).toEqual(["202510"]);
    const day = (res.days as Array<Record<string, unknown>>)[0];
    expect(day).toMatchObject({ time: "01", total: 10, Negative: 2 });
    expect(day).not.toHaveProperty("articles");
  });
});
