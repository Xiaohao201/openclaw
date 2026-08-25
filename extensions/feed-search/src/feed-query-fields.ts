/**
 * Whitelists for the feed_query tool. Every identifier that can reach SQL
 * text lives here; user/LLM input only ever binds as parameter values.
 * Declaration order is the deterministic output order (prompt-cache safe).
 */

/** Risk levels accepted as filters (feed_monitor_item.level enum). */
export const LEVELS = ["Red", "Orange", "Yellow", "Blue"] as const;

/** Sentiment values accepted as filters (feed_monitor_item.emotion enum). */
export const EMOTIONS = ["Positive", "Neutral", "Negative"] as const;

/**
 * dimension name -> safe SQL expression for stats GROUP BY.
 * Mirrors extensions/report-generator/src/query-plan.ts.
 */
export const AGGREGATION_DIMENSIONS: Record<string, string> = {
  platform: "f.platform",
  emotion: "f.emotion",
  level: "f.level",
  mediaLevel: "f.mediaLevel",
  city: "f.city",
  contentType: "f.contentType",
  day: "DATE(f.date)",
};

/** Dimensions used when the agent omits groupBy in stats mode. */
export const DEFAULT_STATS_DIMENSIONS = ["level", "emotion", "platform", "day"] as const;

/**
 * Columns returned by search mode, in deterministic order. This is the
 * visible-field whitelist: internal pipeline flags (skip/pushed/vectored/...)
 * and the raw result JSON never leave the database.
 */
export const SEARCH_COLUMNS = [
  "f.id",
  "d.title",
  "d.summary",
  "d.author",
  "f.platform",
  "f.level",
  "f.emotion",
  "f.date",
  "f.link",
  "f.mediaLevel",
  "f.contentType",
  "f.city",
  "f.readCount",
  "f.comments",
  "f.forwardNumber",
  "f.praiseNum",
] as const;

/** Matches at or below this count are read in full. */
export const FULL_READ_THRESHOLD = 100;

/** Detail count used when a larger result set must be sampled. */
export const SEARCH_SAMPLE_SIZE_DEFAULT = 100;
export const SEARCH_LIMIT_MAX = 100;

/** Legacy search default, retained for callers of buildSearchQuery(). */
export const SEARCH_LIMIT_DEFAULT = 20;

/** Maximum serialized characters exposed to the model for one search result. */
export const SEARCH_RESULT_CHAR_BUDGET = 40_000;

/**
 * Per-field limits keep every selected row visible without one row dominating
 * the result. Narrative limits reflect a recent 10,000-row length sample;
 * enum limits match the longest value declared by the MySQL schema.
 */
export const SEARCH_TEXT_FIELD_LIMITS: Readonly<Record<string, number>> = {
  title: 120,
  summary: 300,
  author: 40,
  platform: 16,
  level: 6,
  emotion: 8,
  date: 24,
  link: 320,
  mediaLevel: 10,
  contentType: 7,
  city: 16,
};

/** Structured values stay complete when narrative fields are scaled to fit the result budget. */
export const SEARCH_UNSCALED_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "platform",
  "level",
  "emotion",
  "date",
  "mediaLevel",
  "contentType",
  "city",
]);

/** Max buckets returned per stats dimension. */
export const STATS_BUCKET_MAX = 30;
