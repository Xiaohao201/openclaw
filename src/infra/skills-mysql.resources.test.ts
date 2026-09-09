import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closePool,
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
