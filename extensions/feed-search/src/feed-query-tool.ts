import { Type } from "@sinclair/typebox";
import type { RowDataPacket } from "mysql2/promise";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { AuthTopicResolver, type AuthorizedTopic } from "./auth-topic-resolver.js";
import {
  buildFullSearchQuery,
  buildSampleSearchQuery,
  buildSearchCountQuery,
  buildStatsQueries,
  UnauthorizedTopicError,
  type FeedQueryFilters,
} from "./feed-query-builder.js";
import {
  AGGREGATION_DIMENSIONS,
  EMOTIONS,
  FULL_READ_THRESHOLD,
  LEVELS,
  SEARCH_COLUMNS,
  SEARCH_LIMIT_MAX,
  SEARCH_RESULT_CHAR_BUDGET,
  SEARCH_TEXT_FIELD_LIMITS,
  SEARCH_UNSCALED_TEXT_FIELDS,
} from "./feed-query-fields.js";
import { executeQuery, resolveConfig } from "./mysql-client.js";

/**
 * Chat agents spawned by the rabbitmq-consumer pipeline are named
 * `rabbitmq-<userId>` (see extensions/rabbitmq-consumer/src/chat-pipeline.ts).
 * The captured userId is the trusted identity for topic authorization —
 * never accept a userId from tool parameters.
 */
const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const FeedQueryToolSchema = Type.Object(
  {
    mode: Type.Optional(
      stringEnum(
        ["search", "stats"] as const,
        '"search" (default) returns matching items; "stats" returns aggregate counts over the full filtered set.',
      ),
    ),
    topicId: Type.Optional(
      Type.Number({
        description:
          "Monitoring topic (project) id to query. Omit to use your primary topic. " +
          "Must be one of the topics you are authorized for (see the [topicId:...] message prefix).",
      }),
    ),
    startDate: Type.Optional(
      Type.String({ description: "Inclusive start date, YYYY-MM-DD (Asia/Shanghai)." }),
    ),
    endDate: Type.Optional(
      Type.String({ description: "Inclusive end date, YYYY-MM-DD (Asia/Shanghai)." }),
    ),
    level: Type.Optional(
      Type.Array(stringEnum(LEVELS, "Risk level."), {
        description: "Filter by risk level(s): Red (highest) to Blue (lowest).",
      }),
    ),
    emotion: Type.Optional(
      Type.Array(stringEnum(EMOTIONS, "Sentiment."), {
        description: "Filter by sentiment value(s).",
      }),
    ),
    platform: Type.Optional(
      Type.String({ description: "Exact platform name filter (e.g. 微博, 微信, 抖音)." }),
    ),
    keyword: Type.Optional(
      Type.String({ description: "Substring matched against title, summary, and content." }),
    ),
    groupBy: Type.Optional(
      Type.Array(
        stringEnum(
          Object.keys(AGGREGATION_DIMENSIONS) as unknown as readonly string[],
          "Aggregation dimension.",
        ),
        { description: "Stats mode only: dimensions to group counts by." },
      ),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
        description:
          `Search mode only: sample size when more than ${FULL_READ_THRESHOLD} items match ` +
          `(default and max ${SEARCH_LIMIT_MAX}). Smaller result sets are always read in full.`,
      }),
    ),
  },
  { additionalProperties: false },
);

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

function readOptionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function parseFilters(rawParams: Record<string, unknown>): FeedQueryFilters {
  return {
    topicId: readOptionalInt(rawParams.topicId),
    startDate: readOptionalString(rawParams.startDate),
    endDate: readOptionalString(rawParams.endDate),
    level: readStringArray(rawParams.level),
    emotion: readStringArray(rawParams.emotion),
    platform: readOptionalString(rawParams.platform),
    keyword: readOptionalString(rawParams.keyword),
    groupBy: readStringArray(rawParams.groupBy),
    limit: readOptionalInt(rawParams.limit),
  };
}

function topicSummary(
  topics: AuthorizedTopic[],
): Array<{ topicId: number; topicName: string | null }> {
  // Sorted by topicId so the LLM-visible list is deterministic regardless of
  // entity_auth row order (prompt-cache friendly).
  return topics
    .map((t) => ({ topicId: t.topicId, topicName: t.topicName }))
    .toSorted((a, b) => a.topicId - b.topicId);
}

/**
 * Create the feed_query tool factory. The factory only exposes the tool to
 * `rabbitmq-<userId>` agents; every execution re-resolves the user's
 * authorized topics server-side and queries through parameterized,
 * whitelist-projected SQL.
 */
export function createFeedQueryToolFactory(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});
  const resolver = new AuthTopicResolver(config);

  return (ctx: { agentId?: string }) => {
    const match = RABBITMQ_AGENT_PATTERN.exec(ctx.agentId ?? "");
    const userId = match?.[1];
    if (!userId) {
      return null;
    }

    return {
      name: "feed_query",
      label: "Feed Query",
      description:
        "Query the sentiment-monitoring (舆情) database for your authorized monitoring topics. " +
        'Use mode="search" for matching items plus an exact total count (title, summary, platform, risk level, ' +
        'sentiment, link) and mode="stats" for aggregate counts over the full filtered set. ' +
        `Search reads all results up to ${FULL_READ_THRESHOLD}; larger sets return a stable mixed sample. ` +
        "Access is automatically restricted to topics owned by the current user.",
      parameters: FeedQueryToolSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const mode = rawParams.mode === "stats" ? "stats" : "search";
        const filters = parseFilters(rawParams);

        let topics: AuthorizedTopic[];
        try {
          topics = await resolver.getAuthorizedTopics(userId);
        } catch (error) {
          api.logger.error(`[FEED_QUERY] topic resolution failed for ${userId}: ${String(error)}`);
          return jsonResult({
            success: false,
            error: "Failed to resolve your authorized topics; try again later.",
          });
        }
        if (topics.length === 0) {
          return jsonResult({
            success: false,
            error: "No authorized monitoring topics for this account.",
          });
        }

        try {
          if (mode === "stats") {
            return jsonResult(await runStats(config, filters, topics));
          }
          return await runSearch(config, filters, topics);
        } catch (error) {
          if (error instanceof UnauthorizedTopicError) {
            return jsonResult({
              success: false,
              error: error.message,
              authorizedTopics: topicSummary(error.authorizedTopics),
            });
          }
          if (
            error instanceof RangeError ||
            (error instanceof Error && /YYYY-MM-DD/.test(error.message))
          ) {
            // Parameter validation errors only echo the caller's own input.
            return jsonResult({ success: false, error: error.message });
          }
          api.logger.error(`[FEED_QUERY] query failed for user ${userId}: ${String(error)}`);
          return jsonResult({
            success: false,
            error: "Query execution failed; see gateway logs for details.",
          });
        }
      },
    };
  };
}

type DbConfig = ReturnType<typeof resolveConfig>;

type SearchReadMode = "full" | "sample";

const SEARCH_RESULT_FIELDS = SEARCH_COLUMNS.map((column) => column.slice(column.indexOf(".") + 1));

function truncateText(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) {
    return { value, truncated: false };
  }
  if (limit <= 1) {
    return { value: "…", truncated: true };
  }
  return { value: `${value.slice(0, limit - 1)}…`, truncated: true };
}

function normalizeSearchValue(
  field: string,
  value: unknown,
  scale: number,
): { value: unknown; truncated: boolean } {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { value: value ?? null, truncated: false };
  }
  if (value instanceof Date) {
    return { value: value.toISOString(), truncated: false };
  }

  if (typeof value !== "string" && typeof value !== "bigint") {
    return { value: null, truncated: true };
  }
  const text = typeof value === "bigint" ? value.toString() : value;
  const baseLimit = SEARCH_TEXT_FIELD_LIMITS[field] ?? 64;
  const effectiveScale = SEARCH_UNSCALED_TEXT_FIELDS.has(field) ? 1 : scale;
  const scaledLimit = Math.max(1, Math.floor(baseLimit * effectiveScale));
  return truncateText(text, scaledLimit);
}

function compactSearchItems(rows: Array<Record<string, unknown>>, scale: number) {
  let fieldsTruncated = false;
  const items = rows.map((row) => {
    const item: Record<string, unknown> = {};
    for (const field of SEARCH_RESULT_FIELDS) {
      const normalized = normalizeSearchValue(field, row[field], scale);
      item[field] = normalized.value;
      fieldsTruncated ||= normalized.truncated;
    }
    return item;
  });
  return { items, fieldsTruncated };
}

function buildModelPayload(
  metadata: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
) {
  return {
    ...metadata,
    columns: SEARCH_RESULT_FIELDS,
    // Columnar rows avoid repeating 16 JSON keys for every model-visible item.
    items: items.map((item) => SEARCH_RESULT_FIELDS.map((field) => item[field])),
  };
}

function boundedSearchResult(params: {
  topic: AuthorizedTopic;
  total: number;
  rows: Array<Record<string, unknown>>;
  readMode: SearchReadMode;
}) {
  const sampled = params.readMode === "sample";
  const metadata: Record<string, unknown> = {
    success: true,
    topic: { topicId: params.topic.topicId, topicName: params.topic.topicName },
    total: params.total,
    returnedCount: params.rows.length,
    count: params.rows.length,
    readMode: params.readMode,
    sampled,
    fullReadThreshold: FULL_READ_THRESHOLD,
    sampleSize: params.rows.length,
    ...(sampled ? { samplingMethod: "recent-risk-temporal-v1" } : {}),
  };

  const scales = [1, 0.75, 0.5, 0.35, 0.25, 0.15, 0.08, 0];
  for (const scale of scales) {
    const compacted = compactSearchItems(params.rows, scale);
    const details = {
      ...metadata,
      fieldsTruncated: compacted.fieldsTruncated,
      items: compacted.items,
    };
    const text = JSON.stringify(
      buildModelPayload(
        { ...metadata, fieldsTruncated: compacted.fieldsTruncated },
        compacted.items,
      ),
    );
    if (text.length <= SEARCH_RESULT_CHAR_BUDGET) {
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    }
  }

  // The zero-scale representation keeps all selected ids/rows and is expected
  // to fit. Treat a future schema expansion that breaks this invariant as a
  // query failure instead of silently dropping records.
  throw new RangeError(
    `Search result metadata exceeds the ${SEARCH_RESULT_CHAR_BUDGET}-character budget`,
  );
}

async function runSearch(config: DbConfig, filters: FeedQueryFilters, topics: AuthorizedTopic[]) {
  const countQuery = buildSearchCountQuery(filters, topics);
  const countRows = await executeQuery<RowDataPacket[]>(config, countQuery.sql, countQuery.values);
  const total = Number(countRows?.[0]?.cnt) || 0;

  if (total === 0) {
    return boundedSearchResult({ topic: countQuery.topic, total, rows: [], readMode: "full" });
  }

  const readMode: SearchReadMode = total <= FULL_READ_THRESHOLD ? "full" : "sample";
  const detailQuery =
    readMode === "full"
      ? buildFullSearchQuery(filters, topics)
      : buildSampleSearchQuery(filters, topics);
  const rows = await executeQuery<RowDataPacket[]>(config, detailQuery.sql, detailQuery.values);
  const items: Array<Record<string, unknown>> = rows ?? [];
  return boundedSearchResult({ topic: countQuery.topic, total, rows: items, readMode });
}

async function runStats(config: DbConfig, filters: FeedQueryFilters, topics: AuthorizedTopic[]) {
  const { topic, totalQuery, dimensionQueries } = buildStatsQueries(filters, topics);
  const totalRows = await executeQuery<RowDataPacket[]>(config, totalQuery.sql, totalQuery.values);
  const total = Number(totalRows?.[0]?.cnt) || 0;

  const aggregations: Array<{
    dimension: string;
    buckets: Array<{ value: string; count: number }>;
  }> = [];
  for (const query of dimensionQueries) {
    const rows = await executeQuery<RowDataPacket[]>(config, query.sql, query.values);
    aggregations.push({
      dimension: query.dimension,
      buckets: (rows ?? []).map((row) => ({
        value: row.value === null || row.value === undefined ? "(none)" : String(row.value),
        count: Number(row.cnt) || 0,
      })),
    });
  }

  return {
    success: true,
    topic: { topicId: topic.topicId, topicName: topic.topicName },
    total,
    aggregations,
  };
}
