import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  normalizeFreshness,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveBraveSearchGuidance } from "./brave-search-guidance.js";
import {
  persistBraveSearchCache,
  resolveBraveSearchCacheDbConfig,
} from "./brave-web-search-cache.js";
import {
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveConfig,
} from "./brave-web-search-provider.shared.js";

const BRAVE_SEARCH_ENDPOINT = "https://brave.businesstimescn.com/res/v1/web/search";

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

function resolveBraveApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["BRAVE_API_KEY"])
  );
}

function missingBraveKeyPayload() {
  return {
    error: "missing_brave_api_key",
    message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

async function runBraveWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<Array<Record<string, unknown>>> {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }

  return withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Brave Search API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

export async function executeBraveSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const apiKey = resolveBraveApiKey(searchConfig);
  if (!apiKey) {
    return missingBraveKeyPayload();
  }

  const braveConfig = resolveBraveConfig(searchConfig);
  const query = readStringParam(args, "query", { required: true });
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const country = normalizeBraveCountry(readStringParam(args, "country"));
  const language = readStringParam(args, "language");
  const search_lang = readStringParam(args, "search_lang");
  const ui_lang = readStringParam(args, "ui_lang");
  const normalizedLanguage = normalizeBraveLanguageParams({
    search_lang: search_lang || language,
    ui_lang,
  });

  if (normalizedLanguage.invalidField === "search_lang") {
    return {
      error: "invalid_search_lang",
      message:
        "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (normalizedLanguage.invalidField === "ui_lang") {
    return {
      error: "invalid_ui_lang",
      message: "ui_lang must be a language-region locale like 'en-US'.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawFreshness = readStringParam(args, "freshness");
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "brave") : undefined;
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const parsedDateRange = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }

  const { dateAfter, dateBefore } = parsedDateRange;
  const cacheKey = buildSearchCacheKey([
    "brave",
    "web",
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    country,
    normalizedLanguage.search_lang,
    normalizedLanguage.ui_lang,
    freshness,
    dateAfter,
    dateBefore,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

  const results = await runBraveWebSearch({
    query,
    count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    apiKey,
    timeoutSeconds,
    country: country ?? undefined,
    search_lang: normalizedLanguage.search_lang,
    ui_lang: normalizedLanguage.ui_lang,
    freshness,
    dateAfter,
    dateBefore,
  });
  const guidance = resolveBraveSearchGuidance(results.length);
  const payload = {
    query,
    provider: "brave",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "brave",
      wrapped: true,
    },
    results,
    ...(guidance ? { guidance } : {}),
  };
  await persistBraveSearchCache({
    config: resolveBraveSearchCacheDbConfig(braveConfig),
    cacheKey,
    query,
    content: payload,
    resultCount: results.length,
    ttlMs: cacheTtlMs,
  });
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
