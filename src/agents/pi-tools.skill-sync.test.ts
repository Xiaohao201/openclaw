import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { SkillRow } from "../infra/skills-mysql.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

vi.mock("./skills/refresh-state.js", () => ({
  bumpSkillsSnapshotVersion: vi.fn(),
}));

vi.mock("../infra/skills-mysql.js", async (importActual) => {
  const actual = await importActual<typeof import("../infra/skills-mysql.js")>();
  return {
    ...actual,
    getSkillByName: vi.fn(),
    updateSkill: vi.fn(),
    invalidateSkillsMaterializeCache: vi.fn(),
  };
});

const skillsMysql = await import("../infra/skills-mysql.js");
const { bumpSkillsSnapshotVersion } = await import("./skills/refresh-state.js");
const { wrapToolWithSkillWriteSync, resolveWorkspaceSkillName } =
  await import("./pi-tools.skill-sync.js");
const { createOpenClawCodingTools } = await import("./pi-tools.js");

const getSkillByName = vi.mocked(skillsMysql.getSkillByName);
const updateSkill = vi.mocked(skillsMysql.updateSkill);
const bump = vi.mocked(bumpSkillsSnapshotVersion);

const SESSION_KEY = "agent:rabbitmq-1749:rabbitmq:1749:session_abc";
const WORKSPACE = path.resolve("/tmp/ws");

function row(over: Partial<SkillRow> = {}): SkillRow {
  return {
    id: 7,
    user_id: 1749,
    name: "flow",
    description: "old desc",
    content: "old body",
    source: "workspace",
    category: null,
    is_enable: 1,
    references: null,
    scripts: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

function fakeWriteTool(): AnyAgentTool {
  return {
    name: "write",
    label: "write",
    description: "write",
    parameters: {},
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "Wrote file" }] })),
  } as unknown as AnyAgentTool;
}

function texts(result: { content: readonly unknown[] }): string[] {
  return result.content
    .filter((block): block is { type: "text"; text: string } => {
      return !!block && typeof block === "object" && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveWorkspaceSkillName", () => {
  it.each([
    [path.join(WORKSPACE, "skills", "flow", "SKILL.md"), "flow"],
    [path.join(WORKSPACE, "skills", "flow", "skill.md"), "flow"],
  ])("matches %s", (absolutePath, expected) => {
    expect(resolveWorkspaceSkillName({ absolutePath, workspaceDir: WORKSPACE })).toBe(expected);
  });

  it.each([
    [path.join(WORKSPACE, "skills", "flow", "run.py")],
    [path.join(WORKSPACE, "skills", "SKILL.md")],
    [path.join(WORKSPACE, "notes", "flow", "SKILL.md")],
    [path.join(WORKSPACE, "skills", "flow", "nested", "SKILL.md")],
    [path.resolve("/elsewhere/skills/flow/SKILL.md")],
  ])("ignores %s", (absolutePath) => {
    expect(resolveWorkspaceSkillName({ absolutePath, workspaceDir: WORKSPACE })).toBeUndefined();
  });
});

describe("wrapToolWithSkillWriteSync", () => {
  it("leaves the tool untouched when the session has no skills user id", () => {
    const tool = fakeWriteTool();
    expect(wrapToolWithSkillWriteSync(tool, { workspaceDir: WORKSPACE })).toBe(tool);
  });

  it("writes the new SKILL.md body back to the user's catalog", async () => {
    getSkillByName.mockResolvedValue(row());
    updateSkill.mockResolvedValue(row());
    const wrapped = wrapToolWithSkillWriteSync(fakeWriteTool(), {
      workspaceDir: WORKSPACE,
      agentSessionKey: SESSION_KEY,
    });

    const result = await wrapped.execute("id", {
      path: "skills/flow/SKILL.md",
      content: "# new body",
    });

    expect(updateSkill).toHaveBeenCalledWith(7, { content: "# new body" }, 1749);
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({ changedPath: "skills/flow/SKILL.md" }),
    );
    expect(texts(result).join("\n")).toMatch(/Synced to the user's skill library/);
  });

  it("keeps the catalog description in step with frontmatter", async () => {
    getSkillByName.mockResolvedValue(row());
    updateSkill.mockResolvedValue(row());
    const wrapped = wrapToolWithSkillWriteSync(fakeWriteTool(), {
      workspaceDir: WORKSPACE,
      agentSessionKey: SESSION_KEY,
    });

    await wrapped.execute("id", {
      path: "skills/flow/SKILL.md",
      content: "---\nname: flow\ndescription: brand new summary\n---\n\nbody",
    });

    expect(updateSkill).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ description: "brand new summary" }),
      1749,
    );
  });

  it("warns instead of silently losing the change when the skill is not in the catalog", async () => {
    getSkillByName.mockResolvedValue(null);
    const wrapped = wrapToolWithSkillWriteSync(fakeWriteTool(), {
      workspaceDir: WORKSPACE,
      agentSessionKey: SESSION_KEY,
    });

    const result = await wrapped.execute("id", {
      path: "skills/orphan/SKILL.md",
      content: "# body",
    });

    expect(updateSkill).not.toHaveBeenCalled();
    expect(texts(result).join("\n")).toMatch(/NOT saved/);
  });

  it("warns rather than throwing when the catalog write fails", async () => {
    getSkillByName.mockResolvedValue(row());
    updateSkill.mockRejectedValue(new Error("Access denied for user 'btclaw'@'10.0.0.5'"));
    const wrapped = wrapToolWithSkillWriteSync(fakeWriteTool(), {
      workspaceDir: WORKSPACE,
      agentSessionKey: SESSION_KEY,
    });

    const result = await wrapped.execute("id", { path: "skills/flow/SKILL.md", content: "# body" });
    const joined = texts(result).join("\n");
    expect(joined).toMatch(/NOT saved/);
    expect(joined).not.toMatch(/btclaw/);
  });

  it("reads the file back for edit-style tools that supply no content", async () => {
    getSkillByName.mockResolvedValue(row());
    updateSkill.mockResolvedValue(row());
    const readFile = vi.fn(async () => "# patched body");
    const wrapped = wrapToolWithSkillWriteSync(fakeWriteTool(), {
      workspaceDir: WORKSPACE,
      agentSessionKey: SESSION_KEY,
      readFile,
    });

    await wrapped.execute("id", {
      path: "skills/flow/SKILL.md",
      edits: [{ oldText: "old", newText: "patched" }],
    });

    expect(readFile).toHaveBeenCalledWith(path.join(WORKSPACE, "skills", "flow", "SKILL.md"));
    expect(updateSkill).toHaveBeenCalledWith(7, { content: "# patched body" }, 1749);
  });

  it("passes non-skill paths straight through", async () => {
    const wrapped = wrapToolWithSkillWriteSync(fakeWriteTool(), {
      workspaceDir: WORKSPACE,
      agentSessionKey: SESSION_KEY,
    });

    const result = await wrapped.execute("id", { path: "notes/todo.md", content: "hi" });
    expect(getSkillByName).not.toHaveBeenCalled();
    expect(texts(result)).toEqual(["Wrote file"]);
  });
});

describe("createOpenClawCodingTools skill write-through", () => {
  it("wires the real write and edit tools to the user's skill catalog", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-sync-"));
    try {
      getSkillByName.mockResolvedValue(row());
      updateSkill.mockResolvedValue(row());
      const tools = createOpenClawCodingTools({
        workspaceDir,
        sessionKey: SESSION_KEY,
      });
      const writeTool = tools.find((tool) => tool.name === "write");
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(writeTool).toBeDefined();
      expect(editTool).toBeDefined();

      await writeTool?.execute("write-skill", {
        path: "skills/flow/SKILL.md",
        content: "# first body",
      });
      await editTool?.execute("edit-skill", {
        path: "skills/flow/SKILL.md",
        edits: [{ oldText: "first", newText: "patched" }],
      });

      expect(await fs.readFile(path.join(workspaceDir, "skills", "flow", "SKILL.md"), "utf8")).toBe(
        "# patched body",
      );
      expect(updateSkill).toHaveBeenNthCalledWith(1, 7, { content: "# first body" }, 1749);
      expect(updateSkill).toHaveBeenNthCalledWith(2, 7, { content: "# patched body" }, 1749);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
