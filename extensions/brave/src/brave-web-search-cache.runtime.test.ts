import { acquireMysqlPool } from "openclaw/plugin-sdk/mysql-pool";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeBraveSearchCachePools,
  executeBraveSearchCacheInsert,
} from "./brave-web-search-cache.runtime.js";
vi.mock("openclaw/plugin-sdk/mysql-pool", () => ({
  acquireMysqlPool: vi.fn(() => ({
    execute: vi.fn(async () => [[], []]),
    end: vi.fn(async () => {}),
  })),
}));
const config = {
  host: "db.example",
  port: 3306,
  user: "test",
  password: "example-only",
  database: "test",
};
afterEach(async () => {
  await closeBraveSearchCachePools();
  vi.clearAllMocks();
});
it("reuses a shared-pool handle and releases it when the service stops", async () => {
  await executeBraveSearchCacheInsert(config, "INSERT fixture", []);
  await executeBraveSearchCacheInsert(config, "INSERT fixture", []);
  expect(acquireMysqlPool).toHaveBeenCalledTimes(1);
  const handle = vi.mocked(acquireMysqlPool).mock.results[0].value;
  await closeBraveSearchCachePools();
  expect(handle.end).toHaveBeenCalledTimes(1);
  await executeBraveSearchCacheInsert(config, "INSERT fixture", []);
  expect(acquireMysqlPool).toHaveBeenCalledTimes(2);
});
