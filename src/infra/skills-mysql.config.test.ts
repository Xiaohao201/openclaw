import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  acquireMysqlPool: vi.fn(),
  execute: vi.fn(),
  end: vi.fn(),
}));

vi.mock("../config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("./mysql-pool.js", () => ({ acquireMysqlPool: mocks.acquireMysqlPool }));

import { closePool, getSkillByName } from "./skills-mysql.js";

describe("skill library MySQL configuration", () => {
  const configured = {
    host: "skills-db.example",
    port: 3307,
    user: "skills-user",
    password: "test-password",
    database: "skills-test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ["HOST", "PORT", "USER", "PASSWORD", "DATABASE"]) {
      vi.stubEnv(`MYSQL_${key}`, undefined);
    }
    mocks.loadConfig.mockReturnValue({
      plugins: { entries: { "feed-search": { config: { mysql: configured } } } },
    });
    mocks.execute.mockResolvedValue([[], []]);
    mocks.acquireMysqlPool.mockReturnValue({ execute: mocks.execute, end: mocks.end });
  });

  afterEach(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  it("uses the nested plugin MySQL configuration when looking up a skill", async () => {
    await expect(getSkillByName("example-skill", 126)).resolves.toBeNull();
    expect(mocks.acquireMysqlPool).toHaveBeenCalledWith(configured);
    expect(mocks.execute).toHaveBeenCalledWith(expect.any(String), ["example-skill", 126]);
  });

  it("preserves environment overrides for deployment credentials", async () => {
    vi.stubEnv("MYSQL_HOST", "override.example");
    vi.stubEnv("MYSQL_PORT", "3308");
    vi.stubEnv("MYSQL_USER", "override-user");
    vi.stubEnv("MYSQL_PASSWORD", "override-password");
    vi.stubEnv("MYSQL_DATABASE", "override-db");
    await getSkillByName("example-skill", 126);
    expect(mocks.acquireMysqlPool).toHaveBeenCalledWith({
      host: "override.example",
      port: 3308,
      user: "override-user",
      password: "override-password",
      database: "override-db",
    });
  });
});
