import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import {
  createHotRankToolFactory,
  fetchHotRank,
  type HotRankFetcher,
  type HotRankRequest,
} from "./hot-rank-tool.js";

const fakeApi = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

function parse(result: unknown): Record<string, unknown> {
  const value = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (value?.details && typeof value.details === "object") {
    return value.details as Record<string, unknown>;
  }
  const text = value?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const request: HotRankRequest = {
  date: "2026-08-11 00:00,2026-08-11 23:59",
  keyword: "",
  city: "",
  platform: "weibo",
  rank_type: 1,
};

describe("fetchHotRank", () => {
  it("posts JSON to the fixed hot-rank endpoint without credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, message: "success", data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchHotRank(request)).resolves.toMatchObject({ code: 0, data: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://123.57.81.67:8004/api/v1/hot_rank",
      expect.objectContaining({
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("rejects non-success HTTP responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" }),
    );

    await expect(fetchHotRank(request)).rejects.toThrow("HTTP 503");
  });
});

describe("hot_rank", () => {
  it("is available only to rabbitmq chat agents", () => {
    const fetcher = vi.fn<HotRankFetcher>();
    const factory = createHotRankToolFactory(fakeApi, fetcher);

    expect(factory({ agentId: "telegram-1" })).toBeNull();
    expect(factory({ agentId: "rabbitmq-1749" })?.name).toBe("hot_rank");
  });

  it("queries today's comprehensive ranking and returns a bounded result", async () => {
    const fetcher = vi.fn<HotRankFetcher>().mockResolvedValue({
      code: 0,
      message: "success",
      data: [
        {
          rank: 1,
          title: "热点一",
          platform_en: "weibo",
          score: 9000,
          kw_url: "https://s.weibo.com/1",
          begin_rank_time: "2026-08-11 10:00:00",
          end_rank_time: "2026-08-11 11:00:00",
          max_rank: 1,
          max_score: 9000,
          duration: "1h",
          ignored: "not returned",
        },
        { rank: 2, title: "热点二", platform_en: "weibo", score: 8000 },
      ],
    });
    const tool = createHotRankToolFactory(
      fakeApi,
      fetcher,
      () => new Date("2026-08-11T03:00:00Z"),
    )({
      agentId: "rabbitmq-1749",
    })!;

    const result = parse(await tool.execute("hot-1", { platform: "weibo", limit: 1 }));

    expect(fetcher).toHaveBeenCalledWith({
      date: "2026-08-11 00:00,2026-08-11 23:59",
      keyword: "",
      city: "",
      platform: "weibo",
      rank_type: 1,
    });
    expect(result).toMatchObject({ success: true, total: 2, returned: 1 });
    expect(result.items).toEqual([
      {
        rank: 1,
        title: "热点一",
        platform: "weibo",
        score: 9000,
        url: "https://s.weibo.com/1",
        beginTime: "2026-08-11 10:00:00",
        endTime: "2026-08-11 11:00:00",
        maxRank: 1,
        maxScore: 9000,
        duration: "1h",
      },
    ]);
  });

  it("rejects an invalid date without calling the API", async () => {
    const fetcher = vi.fn<HotRankFetcher>();
    const tool = createHotRankToolFactory(fakeApi, fetcher)({ agentId: "rabbitmq-1749" })!;

    const result = parse(await tool.execute("hot-2", { date: "tomorrow" }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("日期");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an upstream service failure without exposing a stack", async () => {
    const fetcher = vi.fn<HotRankFetcher>().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const tool = createHotRankToolFactory(fakeApi, fetcher)({ agentId: "rabbitmq-1749" })!;

    const result = parse(await tool.execute("hot-3", {}));

    expect(result).toEqual({ success: false, error: "热榜服务暂时不可用，请稍后重试。" });
  });
});
