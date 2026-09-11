import { readFile } from "node:fs/promises";
import { buildSessionContext, parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { z } from "zod";

const entrySchema = z
  .object({
    type: z.string(),
    id: z.string(),
    parentId: z.string().nullable(),
    timestamp: z.string(),
  })
  .passthrough();

/** Resolve the same branch and compaction boundaries as Pi, without opening a writable manager. */
export async function readActiveSkillHistoryFromFile(sessionFile: string): Promise<unknown[]> {
  let transcript: string;
  try {
    transcript = await readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: unknown[] = transcript
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  // Existing snapshots use Pi's serialization. Reject legacy/unknown headers
  // rather than migrate a transcript or mistakenly suppress needed instructions.
  z.object({ type: z.literal("session"), version: z.literal(3) }).parse(records[0]);
  records.slice(1).forEach((entry) => entrySchema.parse(entry));
  // Pi owns the message/compaction payload contract; its pure resolver also
  // handles retained pre-compaction messages and excludes abandoned branches.
  const entries = parseSessionEntries(transcript).filter((entry) => entry.type !== "session");
  return buildSessionContext(entries).messages;
}
