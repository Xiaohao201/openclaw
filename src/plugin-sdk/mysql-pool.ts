/** Version 1 process-local, reference-counted MySQL pool contract. */
export { acquireMysqlPool, resolveMysqlPoolSettings } from "../infra/mysql-pool.js";
export type { MysqlConnectionConfig, MysqlPoolSettings } from "../infra/mysql-pool.js";
