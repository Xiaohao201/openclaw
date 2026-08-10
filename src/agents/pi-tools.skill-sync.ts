import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getSkillByName,
  invalidateSkillsMaterializeCache,
  resolveSkillUserId,
  updateSkill,
} from "../infra/skills-mysql.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getFrontmatterString } from "../shared/frontmatter.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
import { resolveToolPathAgainstWorkspaceRoot } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { parseFrontmatter } from "./skills/frontmatter.js";
import { bumpSkillsSnapshotVersion } from "./skills/refresh-state.js";

const log = createSubsystemLogger("skill-write-sync");

const SKILL_FILE_NAME = "SKILL.md";

export type SkillWriteSyncOptions = {
  /** Workspace root the file tools resolve relative paths against. */
  workspaceDir: string;
  /** Trusted session key — the only source of the skills user id. */
  agentSessionKey?: string;
  agentId?: string;
  /** Container workdir when the tool runs against a sandbox path namespace. */
  containerWorkdir?: string;
  /** Reads the file back after the tool ran (edit gives us no final content). */
  readFile?: (absolutePath: string) => Promise<string>;
};

type SyncOutcome =
  | { kind: "updated"; id: number; name: string }
  | { kind: "not-in-catalog"; name: string }
  | { kind: "failed"; name: string };

/**
 * Match `<workspaceDir>/skills/<name>/SKILL.md` and return `<name>`.
 *
 * Anything deeper (a helper script inside the skill folder) or shallower is not
 * the DB-projected body, so it is left alone.
 */
export function resolveWorkspaceSkillName(params: {
  absolutePath: string;
  workspaceDir: string;
}): string | undefined {
  const relative = path.relative(path.resolve(params.workspaceDir), params.absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.length !== 3) {
    return undefined;
  }
  const [root, name, file] = segments;
  if (root !== "skills" || file?.toLowerCase() !== SKILL_FILE_NAME.toLowerCase()) {
    return undefined;
  }
  return name && name !== "." && name !== ".." ? name : undefined;
}

async function syncSkillBodyToCatalog(params: {
  name: string;
  userId: number;
  content: string;
  workspaceDir: string;
}): Promise<SyncOutcome> {
  const { name, userId, content } = params;
  try {
    const existing = await getSkillByName(name, userId);
    if (!existing) {
      return { kind: "not-in-catalog", name };
    }
    // The SKILL.md body may carry its own frontmatter description; when it does,
    // keep the catalog column in step with it so listings do not drift.
    const frontmatterDescription = getFrontmatterString(
      parseFrontmatter(content),
      "description",
    )?.trim();
    await updateSkill(
      existing.id,
      {
        content,
        ...(frontmatterDescription && frontmatterDescription !== existing.description
          ? { description: frontmatterDescription }
          : {}),
      },
      userId,
    );
    invalidateSkillsMaterializeCache();
    bumpSkillsSnapshotVersion({
      workspaceDir: params.workspaceDir,
      reason: "manual",
      changedPath: `skills/${name}/${SKILL_FILE_NAME}`,
    });
    return { kind: "updated", id: existing.id, name };
  } catch (err) {
    // Never surface raw DB/SQL errors to the model output.
    log.warn(`syncing skill "${name}" after a file write failed: ${formatErrorMessage(err)}`);
    return { kind: "failed", name };
  }
}

function describeOutcome(outcome: SyncOutcome): string {
  if (outcome.kind === "updated") {
    return `Synced to the user's skill library: "${outcome.name}" (id ${outcome.id}) now stores this body.`;
  }
  if (outcome.kind === "not-in-catalog") {
    return `Warning: no skill named "${outcome.name}" exists in the user's skill library, so this file change is NOT saved — the folder is a projection of the library and will be rewritten or ignored. Use skill_save to persist it.`;
  }
  return `Warning: could not write "${outcome.name}" back to the user's skill library, so this file change is NOT saved — the folder is a projection of the library and will be overwritten from it. Retry with skill_save.`;
}

function appendToolResultNote(
  result: AgentToolResult<unknown>,
  note: string,
): AgentToolResult<unknown> {
  const content = Array.isArray(result.content) ? [...result.content] : [];
  content.push({ type: "text", text: note } as (typeof content)[number]);
  return { ...result, content };
}

/**
 * Write-through for DB-backed skills.
 *
 * `<workspace>/skills/<name>/SKILL.md` is materialized from the `skills` table
 * on (almost) every turn, so a `write`/`edit` against it is silently discarded —
 * the user asks to "change a skill", the file changes, the library does not, and
 * the next materialize pass restores the old body. This wrapper closes that gap:
 * after the underlying tool succeeds on such a path, the resulting body is
 * written back to the user's skill row, and the tool result says which of the
 * two happened so the model never reports a save that did not land.
 *
 * It never blocks the write and never throws: a DB problem degrades to a warning
 * appended to the tool result.
 */
export function wrapToolWithSkillWriteSync(
  tool: AnyAgentTool,
  options: SkillWriteSyncOptions,
): AnyAgentTool {
  const rawUserId = resolveSkillUserId(options.agentSessionKey, options.agentId);
  const userId = rawUserId ? Number(rawUserId) : Number.NaN;
  // Only per-user (DB-backed) sessions have a skill library to sync with; for
  // every other deployment the workspace skills dir is the source of truth and
  // must be left exactly as-is.
  if (!Number.isInteger(userId) || userId <= 0) {
    return tool;
  }
  const readFile = options.readFile ?? ((absolutePath) => fs.readFile(absolutePath, "utf-8"));

  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const result = await tool.execute(toolCallId, args, signal, onUpdate);

      const record = getToolParamsRecord(args);
      const filePath = typeof record?.path === "string" ? record.path.trim() : "";
      if (!filePath) {
        return result;
      }
      let absolutePath: string;
      try {
        absolutePath = resolveToolPathAgainstWorkspaceRoot({
          filePath,
          root: options.workspaceDir,
          containerWorkdir: options.containerWorkdir,
        });
      } catch {
        return result;
      }
      const name = resolveWorkspaceSkillName({
        absolutePath,
        workspaceDir: options.workspaceDir,
      });
      if (!name) {
        return result;
      }

      let content: string;
      try {
        // `write` hands us the body directly; `edit` only patched the file, so
        // read back whatever it produced.
        content =
          typeof record?.content === "string" ? record.content : await readFile(absolutePath);
      } catch (err) {
        log.warn(
          `reading back "${absolutePath}" for skill sync failed: ${formatErrorMessage(err)}`,
        );
        return appendToolResultNote(result, describeOutcome({ kind: "failed", name }));
      }

      const outcome = await syncSkillBodyToCatalog({
        name,
        userId,
        content,
        workspaceDir: options.workspaceDir,
      });
      return appendToolResultNote(result, describeOutcome(outcome));
    },
  };
}
