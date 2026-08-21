import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import type {
  BraveSearchCacheDbConfig,
  BraveSearchCacheSqlValue,
} from "./brave-web-search-cache.js";

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
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 3,
    waitForConnections: true,
    connectTimeout: 5000,
    charset: "utf8mb4",
    timezone: "+08:00",
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
