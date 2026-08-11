import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  readResponseText,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  resolveFullTextSearchEndpoint,
  resolveFullTextSearchMaxContentChars,
  resolveFullTextSearchTimeoutSeconds,
} from "./config.js";

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MAX_RESPONSE_BYTES = 8_000_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export type FullTextSearchParams = {
  config?: OpenClawConfig;
  query: string;
  excludeQueries?: string[];
  dateAfter?: string;
  dateBefore?: string;
  platforms?: string[];
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

type RequestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  truncated: boolean;
};

type FullTextSearchDeps = {
  request: (params: {
    url: string;
    timeoutSeconds: number;
    body: Record<string, unknown>;
  }) => Promise<RequestResult>;
};

function formatLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
  );
}

function resolveDateRange(
  params: Pick<FullTextSearchParams, "dateAfter" | "dateBefore">,
  now = new Date(),
): { dateAfter: string; dateBefore: string } {
  const dateBefore = params.dateBefore?.trim() || formatLocalIsoDate(now);
  const defaultAfter = new Date(now);
  defaultAfter.setDate(defaultAfter.getDate() - 30);
  const dateAfter = params.dateAfter?.trim() || formatLocalIsoDate(defaultAfter);
  if (!isValidIsoDate(dateAfter)) {
    throw new Error("dateAfter must use a valid YYYY-MM-DD date.");
  }
  if (!isValidIsoDate(dateBefore)) {
    throw new Error("dateBefore must use a valid YYYY-MM-DD date.");
  }
  if (dateAfter > dateBefore) {
    throw new Error("dateAfter must not be later than dateBefore.");
  }
  return { dateAfter, dateBefore };
}

function normalizeStringArray(value: string[] | undefined, maximum: number): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maximum);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_COUNT, Math.floor(value)))
    : DEFAULT_COUNT;
}

function resolvePage(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function buildRequestBody(params: FullTextSearchParams): Record<string, unknown> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }
  const range = resolveDateRange(params);
  const body: Record<string, unknown> = {
    word: [query],
    date: `${range.dateAfter} 00:00,${range.dateBefore} 23:59`,
    page: resolvePage(params.page),
    page_size: resolveCount(params.count),
  };
  const optionalValues: Array<[string, unknown]> = [
    ["exclude_word", normalizeStringArray(params.excludeQueries, 100)],
    ["platform", normalizeStringArray(params.platforms, 20)],
    ["sentiment", normalizeStringArray(params.sentiments, 3)],
    ["original", params.original?.slice(0, 3)],
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
    title: wrapWebContent(title, "web_search"),
    url,
    ...(description
      ? { snippet: wrapWebContent(truncate(description, 1_000).text, "web_search") }
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
      likes: readNumber(value, "like_count") ?? 0,
      comments: readNumber(value, "comment_count") ?? 0,
      shares: readNumber(value, "share_count") ?? 0,
      views: readNumber(value, "view_count") ?? 0,
      collects: readNumber(value, "collect_count") ?? 0,
      reposts: readNumber(value, "repost_count") ?? 0,
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

async function requestFullTextSearch(params: {
  url: string;
  timeoutSeconds: number;
  body: Record<string, unknown>;
}): Promise<RequestResult> {
  return await withTrustedWebSearchEndpoint(
    {
      url: params.url,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(params.body),
      },
    },
    async (response) => {
      const result = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text: result.text,
        truncated: result.truncated,
      };
    },
  );
}

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
  });
  if (!response.ok) {
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
  const rawResults = Array.isArray(data.list) ? data.list : [];
  const results = rawResults
    .map((entry) => normalizeResult(entry, { includeContent, maxContentChars }))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  return {
    query: params.query.trim(),
    provider: "full-text-search",
    dateRange: range,
    page: readNumber(data, "page") ?? resolvePage(params.page),
    pageSize: readNumber(data, "page_size") ?? resolveCount(params.count),
    total: readNumber(data, "total") ?? results.length,
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
