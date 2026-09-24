import { afterEach, describe, expect, it, vi } from "vitest";
import { startDebugProxy } from "./debug-proxy.js";

const proxies: Awaited<ReturnType<typeof startDebugProxy>>[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  vi.unstubAllEnvs();
});
const body = {
  model: "test",
  messages: [{ role: "user", content: "[JEV_SYNTHETIC_BENCH] hello" }],
};
describe("bounded synthetic debug proxy", () => {
  it("separates a bounded turn decision from subsequent model requests in route mode", async () => {
    vi.stubEnv("JEV_OPENROUTER_API_KEY", "routing-key");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (typeof url === "string" && url.endsWith("/decisions")) {
        const names = [
          "answer",
          "clarify",
          "read",
          "search",
          "memory",
          "query",
          "check",
          "report",
          "write",
          "think",
          "schedule",
          "uncertain",
        ];
        return Response.json({
          answers: {
            route: {
              type: "choice",
              choice: "answer",
              confidence: 0.95,
              probabilities: Object.fromEntries(
                names.map((name) => [name, name === "answer" ? 1 : 0]),
              ),
            },
          },
        });
      }
      return new Response("model-output");
    });
    const log = vi.fn();
    const proxy = await startDebugProxy({
      upstream: "https://example.test/v1",
      mode: "route",
      maxRequests: 1,
      fetch: fetcher,
      log,
    });
    proxies.push(proxy);
    const endpoint = proxy.turnRouterUrl!;
    const state = { request: "[JEV_SYNTHETIC_BENCH] hello", history: [], allowMemory: false };
    const postRoute = () =>
      fetch(endpoint, { method: "POST", body: JSON.stringify(state) }).then((response) =>
        response.json(),
      );
    const results = await Promise.all([postRoute(), postRoute()]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: "answer" }),
        expect.objectContaining({ route: "uncertain" }),
      ]),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(await response.text()).toBe("model-output");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([event]) => event.phase === "turn_decision")).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(state.request);
  });
  it("streams unchanged baseline bytes and enforces synthetic scope, path and budget", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } }),
      );
    const log = vi.fn();
    const proxy = await startDebugProxy({
      upstream: "https://example.test/v1",
      mode: "baseline",
      maxRequests: 1,
      fetch: upstream,
      log,
    });
    proxies.push(proxy);
    expect((await fetch(proxy.baseUrl)).status).toBe(404);
    const post = (text: string) =>
      fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        body: text,
        headers: { authorization: "Bearer test-private" },
      });
    expect((await post(JSON.stringify({ ...body, messages: [] }))).status).toBe(429);
    const text = JSON.stringify(body, null, 2);
    expect(await (await post(text)).text()).toBe("data: hello\n\n");
    expect(upstream.mock.calls[0][1]?.body).toBe(text);
    expect(upstream.mock.calls[0][1]?.redirect).toBe("error");
    expect((await post(text)).status).toBe(429);
    expect(upstream).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-private");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hello");
  });
  it("filters with separate routing credentials and preserves tool results", async () => {
    vi.stubEnv("JEV_OPENROUTER_API_KEY", "routing-private");
    const upstream = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes(
        "/decisions",
      )
        ? Response.json({
            answers: {
              route: {
                type: "choice",
                choice: "no_tools",
                confidence: 0.99,
                probabilities: { no_tools: 0.99, tools: 0.005, abstain: 0.005 },
              },
              candidate_read: { type: "noul", noul: 0.01 },
            },
          })
        : new Response("done"),
    );
    const log = vi.fn();
    const proxy = await startDebugProxy({
      upstream: "https://example.test/v1",
      mode: "filter",
      fetch: upstream,
      log,
    });
    proxies.push(proxy);
    const payload = { ...body, tools: [{ type: "function", function: { name: "read" } }] };
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { authorization: "Bearer model-private" },
    });
    expect(await response.text()).toBe("done");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer routing-private",
    });
    const forwardedBody = upstream.mock.calls[1][1]?.body;
    if (typeof forwardedBody !== "string") {
      throw new Error("Expected JSON request body");
    }
    const forwarded = JSON.parse(forwardedBody);
    expect(forwarded.messages).toEqual(payload.messages);
    expect(forwarded.tools).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });
  it("rejects unsafe upstream configuration and reports upstream failures without secrets", async () => {
    await expect(
      startDebugProxy({ upstream: "http://example.test", mode: "baseline", log: vi.fn() }),
    ).rejects.toThrow("HTTPS");
    const log = vi.fn();
    const proxy = await startDebugProxy({
      upstream: "https://example.test",
      mode: "baseline",
      fetch: vi.fn().mockRejectedValue(new Error("secret")),
      log,
    });
    proxies.push(proxy);
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
