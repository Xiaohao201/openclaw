import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runFullTextSearch } from "./full-text-search-client.js";

const FullTextSearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Keyword or phrase to search for.", minLength: 1 }),
    excludeQueries: Type.Optional(
      Type.Array(Type.String(), {
        description: "Terms that must not appear in matching content.",
        maxItems: 100,
      }),
    ),
    dateAfter: Type.Optional(
      Type.String({ description: "Start date in YYYY-MM-DD format. Defaults to 30 days ago." }),
    ),
    dateBefore: Type.Optional(
      Type.String({ description: "End date in YYYY-MM-DD format. Defaults to today." }),
    ),
    platforms: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Platform filters such as ["微信", "微博", "网页"].',
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
        description: "Upstream originality filters (0-2).",
        maxItems: 3,
      }),
    ),
    reduceNoise: Type.Optional(
      Type.Integer({
        description: "Upstream noise reduction level (0-3).",
        minimum: 0,
        maximum: 3,
      }),
    ),
    order: Type.Optional(Type.String({ description: "Optional upstream result order." })),
    page: Type.Optional(Type.Integer({ description: "Result page, starting at 1.", minimum: 1 })),
    count: Type.Optional(
      Type.Integer({ description: "Results per page (1-20).", minimum: 1, maximum: 20 }),
    ),
    includeContent: Type.Optional(
      Type.Boolean({ description: "Include bounded indexed full text. Defaults to true." }),
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
      "Cost-controlled search of an indexed cross-platform corpus (social posts, news, forums, and web pages). Call it for an explicit Chinese codeword 观象台 search, and call it before web_search for fresh or local social events that need rapid cross-platform discovery. Do not call it for ordinary knowledge, weather, casual mentions, negated search requests, or no-network requests. After indexed discovery, use web_search for open-web and authority-source corroboration and web_fetch to verify or refresh a returned URL.",
    parameters: FullTextSearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) =>
      jsonResult(
        await runFullTextSearch({
          config: api.config,
          query: readStringParam(rawParams, "query", { required: true }),
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
