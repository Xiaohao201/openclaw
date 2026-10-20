import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closePool, getSkillResourceForUser, PUBLIC_SKILL_NAMES } from "./skills-mysql.js";

const db = vi.hoisted(() => ({ execute: vi.fn(), end: vi.fn() }));
const workspaces: string[] = [];
vi.mock("./mysql-pool.js", () => ({ acquireMysqlPool: () => db }));
afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  await closePool();
  vi.resetAllMocks();
});

it.each([false, true])(
  "prefers the authorized local attachment (public=%s)",
  async (publicSkill) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-read-"));
    workspaces.push(workspace);
    const directory = path.join(
      workspace,
      publicSkill ? ".openclaw-public-skills" : "skills",
      "flow",
      "references",
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "guide.md"), "local guide");
    db.execute.mockResolvedValue([
      [
        {
          path: "references/guide.md",
          media_type: "text/markdown",
          user_id: publicSkill ? 126 : 1749,
          category: publicSkill ? "builtin" : null,
          slug: "flow",
        },
      ],
    ]);
    expect(
      await getSkillResourceForUser("flow", "references/guide.md", 1749, workspace),
    ).toMatchObject({ content: "local guide" });
    expect(db.execute).toHaveBeenCalledOnce();
    expect(db.execute.mock.calls[0][0]).not.toContain("resource.content");
  },
);

it.each([null, "bad\0content"])(
  "falls back to database for missing or invalid local content: %s",
  async (content) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-read-"));
    workspaces.push(workspace);
    if (content !== null) {
      const directory = path.join(workspace, "skills", "flow", "references");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "guide.md"), content);
    }
    db.execute
      .mockResolvedValueOnce([
        [
          {
            path: "references/guide.md",
            media_type: "text/markdown",
            user_id: 1749,
            slug: "flow",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            path: "references/guide.md",
            media_type: "text/markdown",
            content: "database guide",
          },
        ],
      ]);
    expect(
      await getSkillResourceForUser("flow", "references/guide.md", 1749, workspace),
    ).toMatchObject({ content: "database guide" });
    expect(db.execute).toHaveBeenCalledTimes(2);
  },
);

it("does not expose local files when the attachment is inaccessible", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "skill-read-"));
  workspaces.push(workspace);
  const directory = path.join(workspace, "skills", "flow", "references");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "guide.md"), "private");
  db.execute.mockResolvedValue([[]]);
  expect(await getSkillResourceForUser("flow", "references/guide.md", 1749, workspace)).toBeNull();
});

it("selects the visible skill before its exact attachment, with public-skill precedence", async () => {
  db.execute.mockResolvedValue([
    [
      {
        path: "references/guide.md",
        media_type: "text/markdown",
        content: "guide",
      },
    ],
  ]);
  expect(await getSkillResourceForUser("flow", "references/guide.md", 1749)).toEqual({
    path: "references/guide.md",
    mediaType: "text/markdown",
    content: "guide",
  });
  expect(db.execute).toHaveBeenCalledOnce();
  const [sql, values] = db.execute.mock.calls[0];
  expect(sql).toContain("is_enable = 1");
  expect(sql).toContain("user_id = ? OR");
  expect(sql).toContain("category = 'builtin'");
  expect(sql).toMatch(/ORDER BY \(user_id = \?\) DESC LIMIT 1/);
  expect(sql).toContain("resource.path = ?");
  expect(values).toEqual(["flow", 1749, 126, ...PUBLIC_SKILL_NAMES, 126, "references/guide.md"]);
});

it("returns a miss without a filesystem fallback", async () => {
  db.execute.mockResolvedValue([[]]);
  expect(await getSkillResourceForUser("private", "references/guide.md", 999)).toBeNull();
});

it("validates resource contents before returning database data", async () => {
  db.execute.mockResolvedValue([
    [
      {
        path: "references/guide.md",
        media_type: "text/markdown",
        content: "bad\0content",
      },
    ],
  ]);
  await expect(getSkillResourceForUser("flow", "references/guide.md", 1749)).rejects.toThrow();
});

it("rejects invalid users and traversal even when called outside the tool", async () => {
  await expect(getSkillResourceForUser("flow", "../secret", 1749)).rejects.toThrow();
  await expect(getSkillResourceForUser("flow", "guide.md", NaN)).rejects.toThrow();
  expect(db.execute).not.toHaveBeenCalled();
});
