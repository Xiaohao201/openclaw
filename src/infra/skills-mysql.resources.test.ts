import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closePool,
  createSkill,
  getSkillResourcesForUser,
  invalidateSkillsMaterializeCache,
  materializeSkillsForUser,
  updateSkill,
  type SkillRow,
} from "./skills-mysql.js";

const db = vi.hoisted(() => ({
  execute: vi.fn(),
  end: vi.fn(),
  getConnection: vi.fn(),
  beginTransaction: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({ default: { createPool: () => db } }));
const roots: string[] = [];
const row: SkillRow = {
  id: 337,
  user_id: 1749,
  name: "Weekly report",
  slug: "weekly-report",
  description: "Report",
  content: "---\nname: weekly-report\n---\nRead [guide](references/guide.md).",
  source: "workspace",
  category: null,
  is_enable: 1,
  references: '["references/guide.md","missing.md","https://example.com"]',
  scripts: null,
  created_at: new Date(0),
  updated_at: new Date(0),
};
let resources = [
  { skill_id: 337, path: "references/guide.md", media_type: "text/markdown", content: "guide v1" },
];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSkillsMaterializeCache();
  resources = [
    {
      skill_id: 337,
      path: "references/guide.md",
      media_type: "text/markdown",
      content: "guide v1",
    },
  ];
  db.getConnection.mockResolvedValue(db);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commit.mockResolvedValue(undefined);
  db.rollback.mockResolvedValue(undefined);
  db.execute.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM skill_resources")) {
      return [resources];
    }
    if (sql.includes("FROM skill_scripts")) {
      return [
        [
          {
            id: 1,
            skill_id: 337,
            script_name: "legacy.md",
            script_content: "legacy data",
            language: "markdown",
          },
        ],
      ];
    }
    if (sql.includes("FROM skills")) {
      return [values?.includes(999) ? [] : [row]];
    }
    return [{ affectedRows: 1 }];
  });
});

it("adds and updates attachments without DELETE permission, preserving omitted paths", async () => {
  resources.push({ skill_id: 337, path: "keep.md", media_type: "text/markdown", content: "keep" });
  const execute = db.execute.getMockImplementation()!;
  db.execute.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("DELETE")) {
      throw new Error("DELETE denied");
    }
    if (sql.startsWith("UPDATE skill_resources")) {
      const entry = resources.find((r) => r.skill_id === values?.[2] && r.path === values?.[3])!;
      entry.media_type = String(values?.[0]);
      entry.content = String(values?.[1]);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO skill_resources")) {
      resources.push({
        skill_id: Number(values?.[0]),
        path: String(values?.[1]),
        media_type: String(values?.[2]),
        content: String(values?.[3]),
      });
      return [{ affectedRows: 1 }];
    }
    return execute(sql, values);
  });
  const resourceUpdates = [
    { path: "references/guide.md", mediaType: "text/markdown", content: "guide v2" },
    { path: "new.txt", mediaType: "text/plain", content: "new" },
  ];
  await updateSkill(337, { resourceUpdates }, 1749);
  await updateSkill(337, { resourceUpdates }, 1749);
  await updateSkill(337, { resourceUpdates: [] }, 1749);
  expect(resources).toHaveLength(3);
  expect(resources.find((r) => r.path === "references/guide.md")?.content).toBe("guide v2");
  expect(resources.find((r) => r.path === "keep.md")?.content).toBe("keep");
  expect(db.commit).toHaveBeenCalledTimes(3);
  expect(db.execute.mock.calls.some(([sql]) => String(sql).includes("skill_scripts"))).toBe(false);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-skill-resources-"));
  roots.push(workspace);
  const [entry] = await materializeSkillsForUser(workspace, "1749");
  expect(await fs.readFile(path.join(entry.skill.baseDir, "references/guide.md"), "utf8")).toBe(
    "guide v2",
  );
  expect(await fs.readFile(path.join(entry.skill.baseDir, "new.txt"), "utf8")).toBe("new");
  expect(await fs.readFile(path.join(entry.skill.baseDir, "keep.md"), "utf8")).toBe("keep");
  expect(await fs.readFile(path.join(entry.skill.baseDir, "legacy.md"), "utf8")).toBe(
    "legacy data",
  );
});

it("checks ownership before incremental writes and rejects mixed modes", async () => {
  expect(await updateSkill(337, { resourceUpdates: [] }, 999)).toBeNull();
  expect(db.execute.mock.calls.some(([sql]) => String(sql).includes("skill_resources"))).toBe(
    false,
  );
  await expect(
    updateSkill(
      337,
      { resources: [], resourceUpdates: [] } as unknown as Parameters<typeof updateSkill>[1],
      1749,
    ),
  ).rejects.toThrow(/mutually exclusive/);
});

it.each(["count", "bytes"])("validates merged attachment %s before writing", async (limit) => {
  resources = Array.from({ length: limit === "count" ? 64 : 4 }, (_, i) => ({
    skill_id: 337,
    path: `file${i}.txt`,
    media_type: "text/plain",
    content: limit === "bytes" ? "x".repeat(1_048_576) : "ok",
  }));
  await expect(
    updateSkill(
      337,
      {
        resourceUpdates: [{ path: "overflow.txt", mediaType: "text/plain", content: "x" }],
      },
      1749,
    ),
  ).rejects.toThrow(limit === "count" ? "Invalid resources array" : "Resources too large");
  expect(db.execute.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/u.test(String(sql)))).toBe(
    false,
  );
  expect(db.rollback).toHaveBeenCalledOnce();
});

it("preserves stored path casing during incremental updates", async () => {
  await updateSkill(
    337,
    {
      resourceUpdates: [
        { path: "References/Guide.md", mediaType: "text/markdown", content: "new" },
      ],
    },
    1749,
  );
  expect(db.execute).toHaveBeenCalledWith(
    "UPDATE skill_resources SET media_type = ?, content = ? WHERE skill_id = ? AND path = ?",
    ["text/markdown", "new", 337, "references/guide.md"],
  );
  expect(
    db.execute.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO skill_resources")),
  ).toBe(false);
});

it("creates attachments without DELETE and rolls back incremental write failures", async () => {
  const execute = db.execute.getMockImplementation()!;
  db.execute.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("DELETE")) {
      throw new Error("DELETE denied");
    }
    if (sql.startsWith("INSERT INTO skills ")) {
      return [{ insertId: 337 }];
    }
    return execute(sql, values);
  });
  const resourceUpdates = [{ path: "new.txt", mediaType: "text/plain", content: "new" }];
  await createSkill({ name: "weekly-report", resourceUpdates }, 1749);
  expect(db.commit).toHaveBeenCalledOnce();
  db.commit.mockClear();
  db.execute.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("INSERT INTO skill_resources")) {
      throw new Error("write failed");
    }
    return execute(sql, values);
  });
  await expect(updateSkill(337, { resourceUpdates }, 1749)).rejects.toThrow("write failed");
  expect(db.rollback).toHaveBeenCalledOnce();
  expect(db.commit).not.toHaveBeenCalled();
});
afterEach(async () => {
  await closePool();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("materializes DB resources in nested directories, preserves legacy files and reports missing references", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "db-skill-resources-"));
  roots.push(workspace);
  const first = await materializeSkillsForUser(workspace, "1749");
  const base = first[0].skill.baseDir;
  expect(await fs.readFile(path.join(base, "references/guide.md"), "utf8")).toBe("guide v1");
  expect(await fs.readFile(path.join(base, "legacy.md"), "utf8")).toBe("legacy data");
  const body = await fs.readFile(first[0].skill.filePath, "utf8");
  expect(body).toContain("Missing legacy attachment: missing.md");
  expect(body).toContain("https://example.com");
  invalidateSkillsMaterializeCache();
  const second = await materializeSkillsForUser(workspace, "1749");
  expect(await fs.readFile(second[0].skill.filePath, "utf8")).toBe(body);
  resources = [];
  invalidateSkillsMaterializeCache();
  await materializeSkillsForUser(workspace, "1749");
  await expect(fs.stat(path.join(base, "references/guide.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(path.join(base, "legacy.md"), "utf8")).toBe("legacy data");
});

it("does not fetch or replace another user's resources", async () => {
  expect(await getSkillResourcesForUser(337, 999)).toEqual([]);
  expect(await updateSkill(337, { resources: [] }, 999)).toBeNull();
  expect(db.execute.mock.calls.some(([sql]) => String(sql).includes("skill_resources"))).toBe(
    false,
  );
});

it("replaces attachments inside the parent update transaction and rolls back on write failure", async () => {
  const execute = db.execute.getMockImplementation()!;
  db.execute.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("INSERT INTO skill_resources")) {
      throw new Error("injected write failure");
    }
    return execute(sql, values);
  });
  await expect(
    updateSkill(
      337,
      { resources: [{ path: "references/guide.md", mediaType: "text/markdown", content: "new" }] },
      1749,
    ),
  ).rejects.toThrow("injected write failure");
  expect(db.beginTransaction).toHaveBeenCalledOnce();
  expect(db.rollback).toHaveBeenCalledOnce();
  expect(db.commit).not.toHaveBeenCalled();
  expect(db.release).toHaveBeenCalledOnce();
});
