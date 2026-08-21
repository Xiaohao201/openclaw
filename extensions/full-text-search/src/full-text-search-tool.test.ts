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
    const hooks: Array<{ name: string; handler: (event: { prompt: string }) => unknown }> = [];
    plugin.register({
      registerTool(tool: unknown, options?: { name?: string }) {
        tools.push({ tool, options });
      },
      on(name: string, handler: (event: { prompt: string }) => unknown) {
        hooks.push({ name, handler });
      },
    } as never);

    expect(plugin.id).toBe("full-text-search");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.options?.name).toBe("full_text_search");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.name).toBe("before_prompt_build");
  });

  it("keeps explicit 观象台 invocation exclusive", () => {
    const hooks: Array<(event: { prompt: string }) => unknown> = [];
    plugin.register({
      registerTool() {},
      on(_name: string, handler: (event: { prompt: string }) => unknown) {
        hooks.push(handler);
      },
    } as never);

    expect(hooks[0]?.({ prompt: "帮我使用观象台，搜索“今天吃饭了嘛？”" })).toEqual({
      prependContext: expect.stringContaining("今天吃饭了嘛？"),
    });
    expect(hooks[0]?.({ prompt: "观象台这个名字怎么样？" })).toBeUndefined();
    expect(hooks[0]?.({ prompt: "不要使用观象台，搜索今天的新闻" })).toBeUndefined();
  });

  it("routes fresh and local social events to full-text search before open-web tools", () => {
    const hooks: Array<(event: { prompt: string }) => unknown> = [];
    plugin.register({
      registerTool() {},
      on(_name: string, handler: (event: { prompt: string }) => unknown) {
        hooks.push(handler);
      },
    } as never);

    const fresh = hooks[0]?.({ prompt: "今天深圳某餐厅发生食品安全事件，查一下" });
    expect(fresh).toEqual({
      prependContext: expect.stringMatching(/full_text_search.*before web_search/su),
    });
    expect((fresh as { prependContext: string }).prependContext).toContain('order="time_desc"');
    expect((fresh as { prependContext: string }).prependContext).toContain(
      "set dateAfter and dateBefore to today's local YYYY-MM-DD date",
    );

    const local = hooks[0]?.({
      prompt: "深圳赛百味维修人员穿鞋踩踏出餐区，撰写该事件舆情速报",
    });
    expect((local as { prependContext: string }).prependContext).toContain(
      'query="深圳赛百味维修人员穿鞋踩踏出餐区"',
    );
    expect((local as { prependContext: string }).prependContext).toContain("Then use web_search");
  });

  it("does not auto-route ordinary or no-network prompts", () => {
    const hooks: Array<(event: { prompt: string }) => unknown> = [];
    plugin.register({
      registerTool() {},
      on(_name: string, handler: (event: { prompt: string }) => unknown) {
        hooks.push(handler);
      },
    } as never);

    expect(hooks[0]?.({ prompt: "今天天气怎么样" })).toBeUndefined();
    expect(hooks[0]?.({ prompt: "不要联网，只根据附件写深圳食品安全舆情报告" })).toBeUndefined();
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

  it("describes fresh and local-event priority without replacing later verification", () => {
    const tool = createFullTextSearchTool({ config: {} } as never);

    expect(tool.description).toContain("fresh or local social events");
    expect(tool.description).toContain("before web_search");
    expect(tool.description).toContain("web_fetch");
  });
});
