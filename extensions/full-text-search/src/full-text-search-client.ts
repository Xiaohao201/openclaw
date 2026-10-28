import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  readResponseText,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  resolveFullTextSearchEndpoint,
  resolveFullTextSearchMaxContentChars,
  resolveFullTextSearchTimeoutSeconds,
} from "./config.js";
import {
  normalizeHitFields,
  normalizePlatforms,
  normalizeQuery,
  normalizeStringArray,
  resolveDateRange,
  resolveSearchWindow,
  SEARCH_ORDERS,
} from "./search-options.js";
import {
  createSearchTransport,
  isRateLimited,
  type SearchRequest,
  type SearchResponse,
} from "./search-transport.js";

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MAX_RESPONSE_BYTES = 8_000_000;

export type FullTextSearchParams = {
  config?: OpenClawConfig;
  query: string | string[];
  excludeQueries?: string[];
  dateAfter?: string;
  dateBefore?: string;
  platforms?: string[];
  hitFields?: string[];
  merge?: boolean;
  endExclusive?: boolean;
  signal?: AbortSignal;
  sentiments?: string[];
  original?: number[];
  reduceNoise?: number;
  order?: string;
  page?: number;
  count?: number;
  includeContent?: boolean;
  maxContentChars?: number;
  timeoutSeconds?: number;
};

type FullTextSearchDeps = {
  request: (params: SearchRequest) => Promise<SearchResponse>;
};

function resolveCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_COUNT, Math.floor(value)))
    : DEFAULT_COUNT;
}

function resolvePage(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function buildRequestBody(params: FullTextSearchParams): Record<string, unknown> {
  const query = normalizeQuery(params.query);
  const range = resolveSearchWindow(params);
  if (params.order && !(SEARCH_ORDERS as readonly string[]).includes(params.order)) {
    throw new Error("Unsupported result order.");
  }
  if (params.order === "similarity_desc" && !params.merge) {
    throw new Error("similarity_desc requires merge=true.");
  }
  if (params.original?.some((value) => ![0, 1, 2].includes(value))) {
    throw new Error("original must contain only 0 (repost), 1 (original), or 2 (comment).");
  }
  if (params.reduceNoise !== undefined && ![0, 1, 2, 3].includes(params.reduceNoise)) {
    throw new Error("reduceNoise must be 0, 1, 2, or 3.");
  }
  const body: Record<string, unknown> = {
    word: query,
    date: `${range.start},${range.end}`,
    page: resolvePage(params.page),
    page_size: resolveCount(params.count),
    merge: params.merge ? 1 : 0,
    save_filter: 0,
  };
  const optionalValues: Array<[string, unknown]> = [
    ["exclude_word", normalizeStringArray(params.excludeQueries, 100)],
    ["platform", normalizePlatforms(params.platforms)],
    ["hit_field", normalizeHitFields(params.hitFields)],
    ["sentiment", normalizeStringArray(params.sentiments, 3)],
    [
      "original",
      params.original ? [...new Set(params.original)].toSorted((a, b) => a - b) : undefined,
    ],
    ["reduce_noise", params.reduceNoise],
    ["order", params.order?.trim() || undefined],
  ];
  for (const [key, value] of optionalValues) {
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function truncate(value: string, maximum: number): { text: string; truncated: boolean } {
  return value.length > maximum
    ? { text: value.slice(0, maximum), truncated: true }
    : { text: value, truncated: false };
}

function normalizeResult(
  value: unknown,
  options: { includeContent: boolean; maxContentChars: number },
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const url = normalizeHttpUrl(value.url);
  if (!url) {
    return undefined;
  }
  const title = readString(value, "title") ?? readString(value, "desc") ?? url;
  const description = readString(value, "desc");
  const content = readString(value, "content");
  const boundedContent = content ? truncate(content, options.maxContentChars) : undefined;
  const result: Record<string, unknown> = {
    id: readString(value, "unique_id") ?? readString(value, "post_id"),
    title: wrapWebContent(truncate(title, 300).text, "web_search"),
    url,
    ...(description
      ? { snippet: wrapWebContent(truncate(description, 360).text, "web_search") }
      : {}),
    ...(readString(value, "nickname")
      ? { author: wrapWebContent(readString(value, "nickname")!, "web_search") }
      : {}),
    ...(readString(value, "platform")
      ? { platform: wrapWebContent(readString(value, "platform")!, "web_search") }
      : {}),
    ...(readString(value, "sentiment")
      ? { sentiment: wrapWebContent(readString(value, "sentiment")!, "web_search") }
      : {}),
    ...(readString(value, "post_create_time")
      ? { publishedAt: readString(value, "post_create_time") }
      : {}),
    metrics: {
      likes: readNumber(value, "like_count") ?? null,
      comments: readNumber(value, "comment_count") ?? null,
      shares: readNumber(value, "share_count") ?? null,
      views: readNumber(value, "view_count") ?? null,
      collects: readNumber(value, "collect_count") ?? null,
      reposts: readNumber(value, "repost_count") ?? null,
    },
  };
  if (options.includeContent && boundedContent) {
    result.content = wrapWebContent(boundedContent.text, "web_search");
    result.contentTruncated = boundedContent.truncated;
  }
  return result;
}

function normalizePlatformCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      )
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

async function requestNative(params: SearchRequest): Promise<SearchResponse> {
  return await withTrustedWebToolsEndpoint(
    {
      url: params.url,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(params.body),
      },
    },
    async ({ response }) => {
      const result = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text: result.text,
        truncated: result.truncated,
        retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
      };
    },
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

const requestFullTextSearch = createSearchTransport(requestNative);

export async function runFullTextSearch(
  params: FullTextSearchParams,
  deps: FullTextSearchDeps = { request: requestFullTextSearch },
): Promise<Record<string, unknown> & { results: Record<string, unknown>[] }> {
  const endpoint = resolveFullTextSearchEndpoint(params.config);
  // Resolve defaults once so a slow request crossing midnight reports the range it actually sent.
  const range = resolveDateRange(params);
  const body = buildRequestBody({ ...params, ...range });
  const response = await deps.request({
    url: endpoint,
    timeoutSeconds: resolveFullTextSearchTimeoutSeconds(params.config, params.timeoutSeconds),
    body,
    signal: params.signal,
  });
  if (!response.ok) {
    if (isRateLimited(response)) {
      return {
        status: "error",
        errorCode: "RATE_LIMITED",
        retryable: false,
        results: [],
        guidance:
          "Automatic rate-limit recovery is exhausted or Retry-After is too long. Do not immediately repeat this query; report the unavailable evidence and preserve successful results.",
      };
    }
    const detail = response.text
      ? wrapWebContent(response.text.slice(0, 1_000), "web_search")
      : response.statusText;
    throw new Error(
      `Full text search API error (${response.status}): ${detail || response.statusText}`,
    );
  }
  if (response.truncated) {
    throw new Error("Full text search response too large.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new Error("Full text search API returned invalid JSON.");
  }
  if (!isRecord(payload)) {
    throw new Error("Full text search API returned an invalid response.");
  }
  if (payload.code !== 0) {
    const message = readString(payload, "message") ?? "unknown error";
    throw new Error(`Full text search API failed: ${wrapWebContent(message, "web_search")}`);
  }
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) {
    throw new Error("Full text search API response is missing data.");
  }
  const maxContentChars = resolveFullTextSearchMaxContentChars(
    params.config,
    params.maxContentChars,
  );
  const includeContent = params.includeContent !== false;
  if (!Array.isArray(data.list)) {
    throw new Error("Full text search API response is missing a valid result list.");
  }
  const rawResults = data.list;
  const results = rawResults
    .slice(0, resolveCount(params.count))
    .map((entry) => normalizeResult(entry, { includeContent, maxContentChars }))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const totalValue = readNumber(data, "total");
  const total =
    totalValue !== undefined && Number.isSafeInteger(totalValue) && totalValue >= 0
      ? totalValue
      : null;
  const mergedValue = readNumber(data, "total_merge");
  const totalMerged =
    params.merge &&
    mergedValue !== undefined &&
    Number.isSafeInteger(mergedValue) &&
    mergedValue >= 0
      ? mergedValue
      : null;
  const totalStatus =
    total === null ? "unavailable" : total >= 5000 ? "possibly_capped" : "reported";
  const page = readNumber(data, "page") ?? resolvePage(params.page);
  const coverage =
    total === null
      ? "unknown"
      : !params.merge &&
          totalStatus === "reported" &&
          page === 1 &&
          results.length === total &&
          rawResults.length === results.length
        ? "complete"
        : "partial";
  return {
    status: "ok",
    query: typeof params.query === "string" ? params.query.trim() : normalizeQuery(params.query),
    provider: "full-text-search",
    dateRange: range,
    effectiveDateRange: resolveSearchWindow({ ...params, ...range }),
    queryScope: body,
    totalStatus,
    totalMerged,
    coverage,
    platformCountsScope: "all-platform-facets",
    guidance:
      "Reuse complete records for calculations when fields are available. Partial results are samples, not a trend. total may be capped at 5000; platformCounts are all-platform facets, not the selected-platform total. Merged counts and pagination limits have different scopes. Indexed counts are not verified relevant-event counts. No daily aggregation is provided.",
    page: readNumber(data, "page") ?? resolvePage(params.page),
    pageSize: readNumber(data, "page_size") ?? resolveCount(params.count),
    total,
    maxPage: readNumber(data, "max_page") ?? 1,
    count: results.length,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "full-text-search",
      wrapped: true,
    },
    platformCounts: normalizePlatformCounts(data.platform),
    results,
  };
}

export const __testing = {
  buildRequestBody,
  normalizeHttpUrl,
  normalizePlatformCounts,
  normalizeResult,
  resolveDateRange,
};
