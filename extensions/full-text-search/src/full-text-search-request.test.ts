import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { endpoint } = vi.hoisted(() => ({ endpoint: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-web-search", () => ({
  withTrustedWebToolsEndpoint: endpoint,
  readResponseText: async (response: Response) => ({
    text: await response.text(),
    truncated: false,
  }),
  wrapWebContent: (value: string) => value,
}));

import { runFullTextSearch } from "./full-text-search-client.js";

function params(path: string) {
  return {
    query: "Example",
    config: {
      plugins: {
        entries: {
          "full-text-search": { config: { endpoint: `https://search.example/${path}` } },
        },
      },
    },
  };
}
const success = () => new Response(JSON.stringify({ code: 0, data: { total: 0, list: [] } }));

beforeEach(() => {
  endpoint.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("native full-text request", () => {
  it("passes cancellation to the network guard and never places it only inside fetch init", async () => {
    const controller = new AbortController();
    endpoint.mockImplementation(async (options, run) => {
      expect(options.signal).toBe(controller.signal);
      expect(options.init.method).toBe("POST");
      expect(JSON.parse(options.init.body)).toMatchObject({ word: ["Example"], save_filter: 0 });
      return run({ response: success() });
    });
    await expect(
      runFullTextSearch({ ...params("signal"), signal: controller.signal }),
    ).resolves.toMatchObject({ coverage: "complete" });
    expect(endpoint).toHaveBeenCalledTimes(1);
  });

  it.each(["7", "date", "invalid"])(
    "recovers a rate limit once using Retry-After=%s",
    async (header) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
      const retryAfter = header === "date" ? new Date(Date.now() + 7000).toUTCString() : header;
      endpoint
        .mockImplementationOnce(async (_options, run) =>
          run({
            response: new Response("", { status: 429, headers: { "Retry-After": retryAfter } }),
          }),
        )
        .mockImplementation(async (_options, run) => run({ response: success() }));
      const pending = runFullTextSearch(params(`retry-${header}`));
      const delay = header === "invalid" ? 5000 : 7000;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(endpoint).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ status: "ok", total: 0 });
      expect(endpoint).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
