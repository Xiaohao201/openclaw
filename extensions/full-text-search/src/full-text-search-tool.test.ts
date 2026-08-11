import { beforeEach, describe, expect, it, vi } from "vitest";

const { runFullTextSearch } = vi.hoisted(() => ({
  runFullTextSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./full-text-search-client.js", () => ({ runFullTextSearch }));

import plugin from "../index.js";
import { createFullTextSearchTool } from "./full-text-search-tool.js";

describe("full_text_search tool", () => {
  beforeEach(() => {
    runFullTextSearch.mockClear();
  });

  it("registers as a dedicated tool so managed web_search remains available", () => {
    const tools: Array<{ tool: unknown; options?: { name?: string } }> = [];
    plugin.register({
      registerTool(tool: unknown, options?: { name?: string }) {
        tools.push({ tool, options });
      },
    } as never);

    expect(plugin.id).toBe("full-text-search");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.options?.name).toBe("full_text_search");
  });

  it("maps rich search filters into the client without replacing web_fetch", async () => {
    const tool = createFullTextSearchTool({
      config: { plugins: { entries: { "full-text-search": { enabled: true } } } },
    } as never);

    const result = await tool.execute("call-1", {
      query: "OpenClaw",
      excludeQueries: ["spam"],
      dateAfter: "2026-08-01",
      dateBefore: "2026-08-11",
      platforms: ["微信"],
      sentiments: ["敏感"],
      original: [1],
      reduceNoise: 2,
      order: "time_desc",
      page: 2,
      count: 6,
      includeContent: true,
      maxContentChars: 4000,
      timeoutSeconds: 45,
    });

    expect(runFullTextSearch).toHaveBeenCalledWith({
      config: { plugins: { entries: { "full-text-search": { enabled: true } } } },
      query: "OpenClaw",
      excludeQueries: ["spam"],
      dateAfter: "2026-08-01",
      dateBefore: "2026-08-11",
      platforms: ["微信"],
      sentiments: ["敏感"],
      original: [1],
      reduceNoise: 2,
      order: "time_desc",
      page: 2,
      count: 6,
      includeContent: true,
      maxContentChars: 4000,
      timeoutSeconds: 45,
    });
    expect(result).toMatchObject({ content: [{ type: "text" }] });
  });
});
