import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runFullTextSearch } from "./full-text-search-client.js";
import { HIT_FIELDS, SEARCH_ORDERS, normalizeQuery } from "./search-options.js";

function stringEnum(values: readonly string[], description: string) {
  return Type.Unsafe<string>({ type: "string", enum: [...values], description });
}

const FullTextSearchToolSchema = Type.Object(
  {
    query: Type.Union(
      [
        Type.String({ minLength: 1, maxLength: 500 }),
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }),
      ],
      {
        description:
          "Keyword groups: array entries are OR; spaces inside each entry are AND. A string is one group, sent upstream as an array. Include public subject/event terms only, not report instructions.",
      },
    ),
    excludeQueries: Type.Optional(
      Type.Array(Type.String(), {
        description: "Terms that must not appear in matching content.",
        maxItems: 100,
      }),
    ),
    dateAfter: Type.Optional(
      Type.String({
        description:
          "Inclusive start in Asia/Shanghai: YYYY-MM-DD (00:00) or YYYY-MM-DD HH:mm. Defaults to 30 days ago; preserve an explicit user window.",
      }),
    ),
    dateBefore: Type.Optional(
      Type.String({
        description:
          "End in Asia/Shanghai: YYYY-MM-DD (23:59) or YYYY-MM-DD HH:mm. The entire end minute is included unless endExclusive=true. Defaults to today.",
      }),
    ),
    endExclusive: Type.Optional(
      Type.Boolean({
        description:
          "Use for [start, end) monitoring windows, such as 09:00 to next 09:00. Requires a minute-precision dateBefore; the adapter subtracts one minute.",
      }),
    ),
    hitFields: Type.Optional(
      Type.Array(stringEnum(HIT_FIELDS, "Keyword match field."), {
        maxItems: 6,
        description:
          "Omit for all fields. For content mentions consider title/content/ocr/asr; include nickname or poi when account/location matches are part of the task.",
      }),
    ),
    merge: Type.Optional(
      Type.Boolean({
        description:
          "Similar-content merging, default false. Use for representative reading; keep false for unmerged work counts. totalMerged is separate from total and platformCounts.",
      }),
    ),
    platforms: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Use codes: douyin, weibo, weixin, toutiao, xiaohongshu, web, app, bbs, enews, jingwai, shipin. Chinese aliases are converted to codes; do not pass them upstream unchanged.",
        maxItems: 20,
      }),
    ),
    sentiments: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Sentiment filters such as ["敏感"] or ["非敏感"].',
        maxItems: 3,
      }),
    ),
    original: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0, maximum: 2 }), {
        description:
          "Originality categories: 0=repost, 1=original, 2=comment. Omit for all; originals-only changes propagation statistics.",
        maxItems: 3,
      }),
    ),
    reduceNoise: Type.Optional(
      Type.Integer({
        description:
          "Content category, not strength: 0=all, 1=normal (upstream default), 2=noise, 3=recommended. Keep the same category across statistics.",
        minimum: 0,
        maximum: 3,
      }),
    ),
    order: Type.Optional(
      stringEnum(
        SEARCH_ORDERS,
        "score for initial relevance checks; time_desc for latest developments; respond_desc/share_desc for reach. Choose for the task, do not run every ordering. similarity_desc requires merge=true.",
      ),
    ),
    page: Type.Optional(Type.Integer({ description: "Result page, starting at 1.", minimum: 1 })),
    count: Type.Optional(
      Type.Integer({
        description:
          "Results per page (1-20), default 5; billing is per returned work. Start small for disambiguation, or retrieve a known small complete set once. count=1 is not a daily aggregation API.",
        minimum: 1,
        maximum: 20,
      }),
    ),
    includeContent: Type.Optional(
      Type.Boolean({
        description:
          "Include bounded indexed full text, default true. Set false for initial discovery/count requests; this trims model context, not upstream billing.",
      }),
    ),
    maxContentChars: Type.Optional(
      Type.Integer({
        description: "Maximum full-text characters per result (500-12000).",
        minimum: 500,
        maximum: 12_000,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description: "Request timeout in seconds (1-120).",
        minimum: 1,
        maximum: 120,
      }),
    ),
  },
  { additionalProperties: false },
);

function readIntegerArray(params: Record<string, unknown>, key: string): number[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const numbers = value.filter(
    (entry): entry is number => typeof entry === "number" && Number.isInteger(entry),
  );
  return numbers.length > 0 ? numbers : undefined;
}

export function createFullTextSearchTool(api: OpenClawPluginApi) {
  return {
    name: "full_text_search",
    label: "Full Text Search",
    description:
      "Search 观象台's indexed cross-platform public corpus. Explicit 观象台 requests go directly here, without feed_query project discovery. " +
      "For fresh or local social events needing discovery, use this before web_search; respect requests for only internal monitoring data or supplied materials. " +
      "Determine subject, time window and deliverable first. Usually inspect a small relevant sample, then fix the query/filter scope for totals, trends and examples. " +
      "Reuse complete records for calculations when required fields are available; never extrapolate population statistics from partial samples. " +
      "Each extra query must resolve a specific ambiguity, missing time segment, statistic or evidence gap; stop when the requested evidence is sufficient. " +
      "total can be capped at 5000, platformCounts are all-platform facets, and totalMerged has a separate scope. Do not mix these counts or treat full-name matches as all relevant company coverage. " +
      "This tool has no daily aggregation or URL-lookup mode. Necessary per-day queries must keep one scope; do not repeat calculations possible from complete results. " +
      "Use web_search for missing public/authority evidence and web_fetch or the browser to verify key claims; do not automatically repeat every search stage. " +
      "A failed query is not zero matches. The adapter performs bounded rate-limit recovery; do not immediately repeat an exhausted request. " +
      "Do not call for ordinary knowledge, weather, casual mentions, negated search requests or no-network requests. Use only public search terms, never private attachment contents.",
    parameters: FullTextSearchToolSchema,
    execute: async (
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal?: AbortSignal,
    ) =>
      jsonResult(
        await runFullTextSearch({
          config: api.config,
          query:
            typeof rawParams.query === "string" ? rawParams.query : normalizeQuery(rawParams.query),
          signal,
          hitFields: readStringArrayParam(rawParams, "hitFields"),
          merge: rawParams.merge === true,
          endExclusive: rawParams.endExclusive === true,
          excludeQueries: readStringArrayParam(rawParams, "excludeQueries"),
          dateAfter: readStringParam(rawParams, "dateAfter"),
          dateBefore: readStringParam(rawParams, "dateBefore"),
          platforms: readStringArrayParam(rawParams, "platforms"),
          sentiments: readStringArrayParam(rawParams, "sentiments"),
          original: readIntegerArray(rawParams, "original"),
          reduceNoise: readNumberParam(rawParams, "reduceNoise", { integer: true }),
          order: readStringParam(rawParams, "order"),
          page: readNumberParam(rawParams, "page", { integer: true }),
          count: readNumberParam(rawParams, "count", { integer: true }),
          includeContent:
            typeof rawParams.includeContent === "boolean" ? rawParams.includeContent : undefined,
          maxContentChars: readNumberParam(rawParams, "maxContentChars", { integer: true }),
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      ),
  };
}
