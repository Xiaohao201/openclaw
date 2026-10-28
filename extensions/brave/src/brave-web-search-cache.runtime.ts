import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import { acquireMysqlPool } from "openclaw/plugin-sdk/mysql-pool";
import type {
  BraveSearchCacheDbConfig,
  BraveSearchCacheSqlValue,
} from "./brave-web-search-cache.types.js";

const pools = new Map<string, mysql.Pool>();

function resolvePoolKey(config: BraveSearchCacheDbConfig): string {
  return createHash("sha256")
    .update(
      [config.host, config.port, config.user, config.password, config.database].join("\u0000"),
    )
    .digest("hex");
}

function getPool(config: BraveSearchCacheDbConfig): mysql.Pool {
  const key = resolvePoolKey(config);
  const existing = pools.get(key);
  if (existing) {
    return existing;
  }
  const pool = acquireMysqlPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });
  pools.set(key, pool);
  return pool;
}

export async function executeBraveSearchCacheInsert(
  config: BraveSearchCacheDbConfig,
  sql: string,
  values: BraveSearchCacheSqlValue[],
): Promise<void> {
  await getPool(config).execute(sql, values);
}

export async function closeBraveSearchCachePools(): Promise<void> {
  const handles = [...pools.values()];
  pools.clear();
  await Promise.all(handles.map((pool) => pool.end()));
}
