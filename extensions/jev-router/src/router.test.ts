import { describe, expect, it, vi } from "vitest";
import { createDecisionClient } from "./client.js";
import { buildRequest, parseConfig, selectCandidates } from "./router.js";

const config = () => parseConfig({ enabled: true, candidates: ["web_search", "read"] });
function answer(route = "tools", read = 0.05, search = 0.95) {
  return {
    answers: {
      route: {
        type: "choice",
        choice: route,
        confidence: 0.9,
        probabilities: {
          tools: route === "tools" ? 0.9 : 0.05,
          no_tools: route === "no_tools" ? 0.9 : 0.05,
          abstain: route === "abstain" ? 0.9 : 0.05,
        },
      },
      candidate_read: { type: "noul", noul: read },
      candidate_web_search: { type: "noul", noul: search },
    },
  };
}

describe("JEV candidate decisions", () => {
  it("is opt-in and rejects tools outside the read-only catalog", () => {
    expect(parseConfig({}).enabled).toBe(false);
    expect(() => parseConfig({ candidates: ["exec"] })).toThrow();
    expect(() => parseConfig({ candidates: ["read", "read"] })).toThrow();
    expect(() => parseConfig({ apiKey: "secret" })).toThrow();
  });
  it("produces identical request bytes across candidate ordering and turns", () => {
    const first = buildRequest("查找今天的新闻", config());
    const reordered = buildRequest(
      "查找今天的新闻",
      parseConfig({ candidates: ["read", "web_search"] }),
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(reordered));
    expect(JSON.stringify(buildRequest("查找今天的新闻", config()))).toBe(JSON.stringify(first));
  });
  it("gives independently evaluated questions the same explicit candidate catalog", () => {
    expect(buildRequest("search", config()).state.candidates.map((tool) => tool.id)).toEqual([
      "read",
      "web_search",
    ]);
  });
  it("selects a subset without mutating the configured candidates", () => {
    const cfg = config();
    const before = [...cfg.candidates];
    expect(selectCandidates(answer(), cfg)).toMatchObject({
      status: "selected",
      candidates: ["web_search"],
    });
    expect(cfg.candidates).toEqual(before);
  });
  it("retains multiple relevant tools for a read-only sequence", () => {
    expect(selectCandidates(answer("tools", 0.8, 0.9), config())).toMatchObject({
      status: "selected",
      candidates: ["read", "web_search"],
    });
  });
  it("distinguishes no tools from abstaining with the original pool", () => {
    expect(selectCandidates(answer("no_tools", 0.01, 0.01), config())).toMatchObject({
      status: "no_tools",
      candidates: [],
    });
    expect(selectCandidates(answer("abstain"), config())).toMatchObject({
      status: "abstain",
      candidates: ["read", "web_search"],
      reason: "model_abstained",
    });
  });
  it("falls back on low confidence and contradictory evidence", () => {
    const low = answer();
    low.answers.route.confidence = 0.2;
    expect(selectCandidates(low, config())).toMatchObject({
      status: "abstain",
      reason: "low_confidence",
    });
    expect(selectCandidates(answer("tools", 0.01, 0.01), config())).toMatchObject({
      status: "abstain",
      reason: "inconsistent_answer",
    });
    expect(selectCandidates(answer("no_tools"), config())).toMatchObject({
      status: "abstain",
      reason: "inconsistent_answer",
    });
  });
  it.each([
    {},
    { answers: {} },
    { answers: { ...answer().answers, injected: { type: "noul", noul: 1 } } },
    { answers: { ...answer().answers, candidate_read: { type: "noul", noul: 2 } } },
    { answers: { ...answer().answers, route: { ...answer().answers.route, choice: "exec" } } },
    {
      answers: {
        ...answer().answers,
        route: {
          ...answer().answers.route,
          probabilities: { tools: 0.9, no_tools: 0.9, abstain: 0.9 },
        },
      },
    },
  ])("rejects malformed or unexpected decisions", (body) => {
    expect(selectCandidates(body, config())).toMatchObject({
      status: "abstain",
      reason: "invalid_response",
    });
  });
});

describe("JEV HTTP boundary", () => {
  it("does not call upstream with an empty pool", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createDecisionClient(parseConfig({}), {
      fetch: fetcher,
      apiKey: () => "test-token",
    });
    expect(await client.decide("hello")).toMatchObject({ reason: "no_candidates" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects missing and oversized response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response("x".repeat(65537)));
    const client = createDecisionClient(config(), { fetch: fetcher, apiKey: () => "test-token" });
    expect(await client.decide("hello")).toMatchObject({ reason: "invalid_response" });
    expect(await client.decide("hello")).toMatchObject({ reason: "invalid_response" });
  });
  it("opens a circuit after repeated failures and recovers after cooldown", async () => {
    let time = 1000;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("error", { status: 503 }));
    const client = createDecisionClient(config(), {
      fetch: fetcher,
      apiKey: () => "test-token",
      now: () => time,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await client.decide("hello")).toMatchObject({ reason: "http_error" });
    }
    expect(await client.decide("hello")).toMatchObject({ reason: "circuit_open" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    time += 30001;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(answer())));
    expect(await client.decide("hello")).toMatchObject({ status: "selected" });
  });
  it("cancels an active request without treating it as an upstream failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const client = createDecisionClient(config(), { fetch: fetcher, apiKey: () => "test-token" });
    const pending = client.decide("hello", controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled" });
  });
  it("uses the decisions endpoint and never follows redirects with credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(answer())));
    const client = createDecisionClient(config(), { fetch: fetcher, apiKey: () => "test-token" });
    expect(await client.decide("Search news")).toMatchObject({ status: "selected" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/alpha/decisions",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("does not send requests without credentials or with oversized/empty state", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createDecisionClient(config(), { fetch: fetcher, apiKey: () => undefined });
    expect(await client.decide("hello")).toMatchObject({ reason: "missing_key" });
    expect(await client.decide(" ")).toMatchObject({ reason: "unsupported_context" });
    expect(await client.decide("a".repeat(20001))).toMatchObject({ reason: "unsupported_context" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])(
    "falls back on HTTP %s without exposing the response body",
    async (status) => {
      const client = createDecisionClient(config(), {
        apiKey: () => "test-token",
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("private-server-error", { status })),
      });
      const result = await client.decide("private user prompt");
      expect(result).toMatchObject({ status: "abstain", reason: "http_error" });
      expect(JSON.stringify(result)).not.toMatch(/private|test-token/);
    },
  );
  it("handles invalid JSON and network failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not json"))
      .mockRejectedValueOnce(new Error("sensitive error"));
    const client = createDecisionClient(config(), { apiKey: () => "test-token", fetch: fetcher });
    expect(await client.decide("hello")).toMatchObject({ reason: "invalid_response" });
    expect(await client.decide("hello")).toMatchObject({ reason: "network_error" });
  });
  it("aborts requests at the deadline and releases concurrency", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const client = createDecisionClient(
      { ...config(), timeoutMs: 20, maxConcurrent: 1 },
      { apiKey: () => "test-token", fetch: fetcher },
    );
    const pending = client.decide("first");
    expect(await client.decide("second")).toMatchObject({ reason: "busy" });
    expect(await pending).toMatchObject({ reason: "timeout" });
    expect(await client.decide("third")).toMatchObject({ reason: "timeout" });
  });
  it("propagates cancellation without a network request when already aborted", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createDecisionClient(config(), { apiKey: () => "test-token", fetch: fetcher });
    expect(await client.decide("hello", AbortSignal.abort())).toMatchObject({
      reason: "cancelled",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
