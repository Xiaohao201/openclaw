import { createHash } from "node:crypto";

export type BraveSearchCacheDbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export type BraveSearchCacheSqlValue = string | number | Date;

type PersistDeps = {
  execute?: (sql: string, values: BraveSearchCacheSqlValue[]) => Promise<unknown>;
  warn?: (message: string) => void;
};

type PersistBraveSearchCacheInput = {
  config?: BraveSearchCacheDbConfig;
  cacheKey: string;
  query: string;
  content: Record<string, unknown>;
  resultCount: number;
  ttlMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvePort(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 3306;
}

/** Resolve provider-owned cache DB settings, with deployment env compatibility. */
export function resolveBraveSearchCacheDbConfig(
  braveConfig: { cacheDb?: unknown },
  env: Record<string, string | undefined> = process.env,
): BraveSearchCacheDbConfig | undefined {
  const raw = isRecord(braveConfig.cacheDb) ? braveConfig.cacheDb : {};
  if (raw.enabled === false) {
    return undefined;
  }

  const host =
    readNonEmptyString(raw.host) ??
    readNonEmptyString(env.WEBSEARCH_CACHE_MYSQL_HOST) ??
    readNonEmptyString(env.WRITER_MYSQL_HOST) ??
    readNonEmptyString(env.HISTORY_MYSQL_HOST);
  const user =
    readNonEmptyString(raw.user) ??
    readNonEmptyString(env.WEBSEARCH_CACHE_MYSQL_USER) ??
    readNonEmptyString(env.WRITER_MYSQL_USER) ??
    readNonEmptyString(env.HISTORY_MYSQL_USER);
  const password =
    readNonEmptyString(raw.password) ??
    readNonEmptyString(env.WEBSEARCH_CACHE_MYSQL_PASSWORD) ??
    readNonEmptyString(env.WRITER_MYSQL_PASSWORD) ??
    readNonEmptyString(env.HISTORY_MYSQL_PASSWORD);
  const database =
    readNonEmptyString(raw.database) ??
    readNonEmptyString(env.WEBSEARCH_CACHE_MYSQL_DATABASE) ??
    readNonEmptyString(env.WRITER_MYSQL_DATABASE) ??
    readNonEmptyString(env.HISTORY_MYSQL_DATABASE) ??
    "superworker";
  if (!host || !user || !password) {
    return undefined;
  }

  return {
    host,
    port: resolvePort(
      raw.port ?? env.WEBSEARCH_CACHE_MYSQL_PORT ?? env.WRITER_MYSQL_PORT ?? env.HISTORY_MYSQL_PORT,
    ),
    user,
    password,
    database,
  };
}

function truncateQuery(query: string): string {
  return Array.from(query).slice(0, 500).join("");
}

/**
 * Best-effort persistence for one actual Brave API response. Every call inserts
 * a new row so repeated searches remain auditable; failures never fail search.
 */
export async function persistBraveSearchCache(
  input: PersistBraveSearchCacheInput,
  deps: PersistDeps = {},
): Promise<void> {
  if (!input.config) {
    return;
  }

  try {
    const values: BraveSearchCacheSqlValue[] = [
      createHash("sha256").update(input.cacheKey).digest("hex"),
      truncateQuery(input.query),
      JSON.stringify(input.content),
      Math.max(0, Math.floor(input.resultCount)),
      new Date(Date.now() + Math.max(0, input.ttlMs)),
    ];
    const sql = `INSERT INTO websearch_cache
      (cache_key, query, results, result_count, cached_at, expires_at, hit_count)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 0)`;
    if (deps.execute) {
      await deps.execute(sql, values);
    } else {
      const { executeBraveSearchCacheInsert } = await import("./brave-web-search-cache.runtime.js");
      await executeBraveSearchCacheInsert(input.config, sql, values);
    }
  } catch {
    (deps.warn ?? console.warn)("[BRAVE] Failed to persist web-search results to websearch_cache");
  }
}
