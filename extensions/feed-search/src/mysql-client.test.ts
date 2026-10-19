import mysql from "mysql2/promise";
import { afterEach, expect, it, vi } from "vitest";
import { closePool, getPool, resolveConfig } from "./mysql-client.js";
vi.mock("mysql2/promise", () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn() })) } }));
afterEach(async () => {
  await closePool();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("reads unified MySQL environment and acquires the shared pool", () => {
  for (const [key, value] of Object.entries({
    MYSQL_HOST: "test-db",
    MYSQL_PORT: "3307",
    MYSQL_USER: "test-user",
    MYSQL_PASSWORD: "test-password",
    MYSQL_DATABASE: "test-schema",
    MYSQL_CONNECTION_LIMIT: "10",
  })) {
    vi.stubEnv(key, value);
  }
  const config = resolveConfig({});
  expect(config).toEqual({
    host: "test-db",
    port: 3307,
    user: "test-user",
    password: "test-password",
    database: "test-schema",
  });
  getPool(config);
  expect(mysql.createPool).toHaveBeenCalledWith(config);
});
it("reuses the module handle and releases it during shutdown", async () => {
  const config = resolveConfig({});
  expect(getPool(config)).toBe(getPool(config));
  expect(mysql.createPool).toHaveBeenCalledTimes(1);
  const pool = getPool(config);
  await closePool();
  expect(pool.end).toHaveBeenCalledTimes(1);
});

// Pool policy and cross-owner lifecycle are covered by the shared pool tests.
vi.mock("openclaw/plugin-sdk/mysql-pool", async () => {
  const { default: mysql } = await import("mysql2/promise");
  return {
    acquireMysqlPool: (config: import("mysql2/promise").PoolOptions) => mysql.createPool(config),
  };
});
