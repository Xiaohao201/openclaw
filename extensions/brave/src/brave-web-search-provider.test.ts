import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import { resolveBraveSearchGuidance } from "./brave-search-guidance.js";
import { __testing, createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const { persistBraveSearchCacheMock } = vi.hoisted(() => ({
  persistBraveSearchCacheMock: vi.fn(async () => {}),
}));

vi.mock("./brave-web-search-cache.js", () => ({
  persistBraveSearchCache: persistBraveSearchCacheMock,
  resolveBraveSearchCacheDbConfig: vi.fn(() => ({
    host: "db.internal",
    port: 3306,
    user: "writer",
    password: "test-password",
    database: "superworker",
  })),
}));

const braveManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as {
  configSchema?: Record<string, unknown>;
};

describe("brave web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    persistBraveSearchCacheMock.mockClear();
    global.fetch = priorFetch;
  });

  it("normalizes brave language parameters and swaps reversed ui/search inputs", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "en-US",
        ui_lang: "ja",
      }),
    ).toEqual({
      search_lang: "jp",
      ui_lang: "en-US",
    });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "tr-TR", ui_lang: "tr" })).toEqual(
      {
        search_lang: "tr",
        ui_lang: "tr-TR",
      },
    );
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "EN", ui_lang: "en-us" })).toEqual(
      {
        search_lang: "en",
        ui_lang: "en-US",
      },
    );
  });

  it("flags invalid brave language fields", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "xx",
      }),
    ).toEqual({ invalidField: "search_lang" });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "en-US" })).toEqual({
      invalidField: "search_lang",
    });
    expect(__testing.normalizeBraveLanguageParams({ ui_lang: "en" })).toEqual({
      invalidField: "ui_lang",
    });
  });

  it("normalizes Brave country codes and falls back unsupported values to ALL", () => {
    expect(__testing.normalizeBraveCountry("de")).toBe("DE");
    expect(__testing.normalizeBraveCountry(" VN ")).toBe("ALL");
    expect(__testing.normalizeBraveCountry("")).toBeUndefined();
  });

  it("defaults brave mode to web unless llm-context is explicitly selected", () => {
    expect(__testing.resolveBraveMode()).toBe("web");
    expect(__testing.resolveBraveMode({ mode: "llm-context" })).toBe("llm-context");
  });

  it("only supplies query-broadening guidance for an empty result set", () => {
    expect(resolveBraveSearchGuidance(0)).toContain("search-index delay");
    expect(resolveBraveSearchGuidance(1)).toBeUndefined();
  });

  it("tells agents how to verify breaking-news claims", () => {
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    expect(tool.description).toContain("freshness=day");
    expect(tool.description).toContain("count=10");
    expect(tool.description).toContain("separate unfiltered authority search");
    expect(tool.description).toContain("web_fetch");
    expect(tool.description).toContain("shorter entity and distinctive-action variants");
    expect(tool.description).toContain("must not be treated as proof");
  });

  it("returns actionable broadening guidance when Brave has no indexed results", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    global.fetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    }) as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "深圳赛百味维修人员穿鞋踩踏出餐区",
      freshness: "day",
      count: 10,
    });

    expect(result).toMatchObject({
      count: 0,
      guidance: expect.stringContaining("shorter entity"),
    });
    expect(result.guidance).toContain("search-index delay");
    expect(result.guidance).toContain("Do not conclude");
    expect(persistBraveSearchCacheMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "深圳赛百味维修人员穿鞋踩踏出餐区",
        content: expect.objectContaining({ results: [] }),
        resultCount: 0,
      }),
    );
  });

  it("accepts llm-context in the Brave plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "llm-context",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("allows operators to disable DB persistence without supplying credentials", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-disabled-cache-db-schema",
      value: {
        webSearch: {
          cacheDb: { enabled: false },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid Brave mode values in the plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "invalid-mode",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "webSearch.mode",
        allowedValues: ["web", "llm-context"],
      }),
    );
  });

  it("maps llm-context results into wrapped source entries", () => {
    expect(
      __testing.mapBraveLlmContextResults({
        grounding: {
          generic: [
            {
              url: "https://example.com/post",
              title: "Example",
              snippets: ["a", "", "b"],
            },
          ],
        },
      }),
    ).toEqual([
      {
        url: "https://example.com/post",
        title: "Example",
        snippets: ["a", "b"],
        siteName: "example.com",
      },
    ]);
  });

  it("returns validation errors for invalid date ranges", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "invalid_date_range",
    });
  });

  it("falls back unsupported country values before calling Brave", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({
      query: "latest Vietnam news",
      country: "VN",
    });

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("country")).toBe("ALL");
  });
});
