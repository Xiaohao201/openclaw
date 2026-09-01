import { beforeEach, describe, expect, it, vi } from "vitest";

const mysqlMocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  end: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: mysqlMocks.createPool,
  },
}));

const { closePool, listSkills } = await import("./skills-mysql.js");

describe("listSkills", () => {
  beforeEach(async () => {
    await closePool();
    vi.clearAllMocks();
    mysqlMocks.createPool.mockReturnValue({
      end: mysqlMocks.end,
      execute: mysqlMocks.execute,
    });
    mysqlMocks.execute.mockResolvedValueOnce([[{ total: 0 }], []]).mockResolvedValueOnce([[], []]);
  });

  it("inlines sanitized pagination integers for MySQL prepared-statement compatibility", async () => {
    await listSkills(1749, { limit: 25.9, offset: -4 });

    const [sql, values] = mysqlMocks.execute.mock.calls[1] ?? [];
    expect(sql).toContain("LIMIT 25 OFFSET 0");
    expect(sql).not.toContain("LIMIT ? OFFSET ?");
    expect(values).toEqual([1749]);
  });

  it("bounds non-finite and excessive pagination values", async () => {
    await listSkills(1749, { limit: Number.POSITIVE_INFINITY, offset: Number.NaN });

    const [sql, values] = mysqlMocks.execute.mock.calls[1] ?? [];
    expect(sql).toContain("LIMIT 50 OFFSET 0");
    expect(values).toEqual([1749]);
  });

  it("caps excessive finite pagination values", async () => {
    await listSkills(1749, { limit: 10_000, offset: Number.MAX_SAFE_INTEGER });

    const [sql, values] = mysqlMocks.execute.mock.calls[1] ?? [];
    expect(sql).toContain("LIMIT 100 OFFSET 2147483647");
    expect(values).toEqual([1749]);
  });
});
