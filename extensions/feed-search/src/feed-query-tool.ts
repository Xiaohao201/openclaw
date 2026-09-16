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
        ["topics", "search", "stats"] as const,
        '"topics" discovers authorized projects without reading articles; "search" (default) searches within an explicit project; "stats" aggregates that project.',
      ),
    ),
    topicId: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Required for search/stats. Automatically pass the sole authorized project's ID when no project is named and no different project is confirmed in this conversation; no user confirmation is needed. Explicit project references must match before querying.",
      }),
    ),
    topicName: Type.Optional(
      Type.String({
        description:
          "Topics mode only: project-name substring, NOT an article keyword. Omit to list authorized projects. No match does not prove that the project does not exist.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Topics mode only: pagination offset (50 projects per page); follow nextOffset when present.",
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
      Type.String({
        description:
          "Search/stats only: substring matched against article title, summary, and content WITHIN topicId. Omit for whole-project overviews; do not copy the project name here unless the user explicitly asks for mentions of it.",
      }),
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
        "First separate the monitoring PROJECT from the CONTENT FILTER. Use mode=topics with topicName to discover projects even when no topic context was injected. " +
        "Selection priority: explicitly named project, then this conversation's confirmed project, then the sole authorized project. " +
        "When no project is named and no project is confirmed in this conversation, automatically select the sole authorized project without asking and pass its topicId to search/stats. " +
        "An explicit project reference always overrides this default: if it does not match, discover/clarify and never substitute the sole project. Multiple authorized projects have no first/primary default; ask only when the intended project remains ambiguous. " +
        "For '今天莱州一中的舆情如何', discover 莱州一中, then use its topicId for stats and representative search WITHOUT keyword. " +
        "For '华泰联合证券的监测里有没有提到莱州一中', select 华泰联合证券 and use keyword=莱州一中. " +
        "For follow-ups like '那昨天呢' or '只看负面的', reuse the last confirmed project and filters from THIS conversation and change only what was requested. " +
        "A named project switch requires fresh matching and clears old content filters unless explicitly retained. If context is missing, discover authorized projects and apply the selection priority above; never reuse another conversation's project. " +
        "State the queried project and date/filter scope in the answer. Zero articles means no matches within that scope, not no authorization or no monitoring coverage. " +
        "Do not substitute public web search for requested internal monitoring data when project selection is unresolved. " +
        'Use mode="search" for matching items plus an exact total count (title, summary, platform, risk level, ' +
        'sentiment, link) and mode="stats" for aggregate counts over the full filtered set. ' +
        `Search reads all results up to ${FULL_READ_THRESHOLD}; larger sets return a stable mixed sample. ` +
        "Access is automatically restricted to topics owned by the current user.",
      parameters: FeedQueryToolSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const mode = rawParams.mode ?? "search";
        if (mode !== "topics" && mode !== "search" && mode !== "stats") {
          return jsonResult({
            success: false,
            code: "INVALID_QUERY",
            error: "Use mode topics, search, or stats.",
          });
        }
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
        if (mode === "topics") {
          if (
            Object.keys(rawParams).some((key) => !["mode", "topicName", "offset"].includes(key))
          ) {
            return jsonResult({
              success: false,
              code: "INVALID_QUERY",
              error:
                "Project discovery accepts only topicName and offset; keyword filters articles, not projects.",
            });
          }
          const offset = rawParams.offset ?? 0;
          if (
            typeof offset !== "number" ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            (rawParams.topicName !== undefined && typeof rawParams.topicName !== "string")
          ) {
            return jsonResult({
              success: false,
              code: "INVALID_QUERY",
              error: "Use a string topicName and a non-negative integer offset.",
            });
          }
          const normalize = (name: string) =>
            name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
          const name = normalize(readOptionalString(rawParams.topicName) ?? "");
          const matches = topicSummary(topics).filter(
            (topic) =>
              !name || (topic.topicName !== null && normalize(topic.topicName).includes(name)),
          );
          const page = matches.slice(offset, offset + 50);
          return jsonResult({
            success: true,
            mode: "topics",
            topics: page,
            matchedCount: matches.length,
            returnedCount: page.length,
            // A unique filtered match is not a single-project account. Only
            // unfiltered discovery may advertise an implicit default.
            defaultTopic: !name && offset === 0 && topics.length === 1 ? page[0] : null,
            nextOffset: offset + page.length < matches.length ? offset + page.length : null,
            guidance:
              "These are authorized project candidates, not article results. Use defaultTopic automatically without asking only if the user named no project and this conversation has no confirmed project. Explicit project references must match; never default after a mismatch. Clarify ambiguous candidates. No name match does not establish nonexistence or lack of permission; try a shorter name or list projects.",
          });
        }
        if (topics.length === 0) {
          return jsonResult({
            success: false,
            code: "NO_AUTHORIZED_TOPICS",
            error: "No authorized monitoring topics for this account.",
          });
        }

        if (rawParams.topicId === undefined) {
          return jsonResult({
            success: false,
            code: "TOPIC_REQUIRED",
            error:
              "Resolve the intended project and pass its topicId. Use mode=topics to discover authorized projects; automatically select its defaultTopic without asking only when the user named no project and no project is confirmed in this conversation. Never default after an explicit project mismatch or treat keyword as a project selector.",
          });
        }
        if (
          typeof rawParams.topicId !== "number" ||
          !Number.isSafeInteger(rawParams.topicId) ||
          rawParams.topicId <= 0 ||
          rawParams.topicName !== undefined ||
          rawParams.offset !== undefined
        ) {
          return jsonResult({
            success: false,
            code: "INVALID_QUERY",
            error:
              "Search/stats require a positive integer topicId. topicName and offset are only for project discovery.",
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
              code: "TOPIC_NOT_AUTHORIZED",
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
