import type mysql from "mysql2/promise";
import { acquireMysqlPool } from "openclaw/plugin-sdk/mysql-pool";
import { withDbRetry } from "./db-retry.js";
import type { MySqlConfig } from "./types.js";

let pool: mysql.Pool | null = null;

function getPool(config: MySqlConfig): mysql.Pool {
  if (!pool) {
    pool = acquireMysqlPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    });
  }
  return pool;
}

/** SELECTs are always retried — reads are inherently idempotent. */
export async function query<T extends mysql.RowDataPacket[]>(
  config: MySqlConfig,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<T> {
  return withDbRetry(
    async () => {
      const [rows] = await getPool(config).execute<T>(sql, (params ?? []) as mysql.ExecuteValues[]);
      return rows;
    },
    { label: "query" },
  );
}

/**
 * Writes are retried ONLY when the caller marks them idempotent (upsert,
 * UPDATE ... WHERE id, CREATE TABLE). A plain INSERT must stay un-retried: a
 * commit-then-dropped-connection blip would otherwise double-insert.
 */
export async function execute(
  config: MySqlConfig,
  sql: string,
  params?: ReadonlyArray<unknown>,
  opts: { idempotent?: boolean } = {},
): Promise<mysql.ResultSetHeader> {
  const run = async () => {
    const [res] = await getPool(config).execute<mysql.ResultSetHeader>(
      sql,
      (params ?? []) as mysql.ExecuteValues[],
    );
    return res;
  };
  return opts.idempotent ? withDbRetry(run, { label: "execute" }) : run();
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
