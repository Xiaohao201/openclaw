import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deduplicateSkillContext, readActiveSkillHistory } from "./session-skill-context.js";

let directory: string;
let file: string;
const body =
  "<enterprise-default-skill>技能全文</enterprise-default-skill>\n<user-task>问题</user-task>";
const message = (id: string, parentId: string | null, content: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-11T00:00:00Z",
  message: { role: "user", content, timestamp: 1 },
});
async function save(entries: unknown[]) {
  const text =
    [
      JSON.stringify({ type: "session", version: 3 }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n";
  await writeFile(file, text);
  return text;
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "skill-history-"));
  file = path.join(directory, "session.jsonl");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("active skill history", () => {
  it("keeps instructions after compaction only if their original message is retained", async () => {
    for (const firstKeptEntryId of ["skill", "next"]) {
      const original = await save([
        message("skill", null, body),
        message("next", "skill", "后续问题"),
        {
          type: "compaction",
          id: "compact",
          parentId: "next",
          timestamp: "2026-09-11T00:00:00Z",
          summary: "已完成前一任务",
          firstKeptEntryId,
          tokensBefore: 1000,
        },
      ]);
      const history = await readActiveSkillHistory(file);
      const result = deduplicateSkillContext(body, "", history);
      expect(result.message.includes("技能全文")).toBe(firstKeptEntryId === "next");
      expect(await readFile(file, "utf8")).toBe(original);
    }
  });

  it("ignores instructions on an abandoned branch", async () => {
    await save([
      message("root", null, "开始"),
      message("old", "root", body),
      message("new", "root", "新分支"),
    ]);
    expect(deduplicateSkillContext(body, "", await readActiveSkillHistory(file)).message).toBe(
      body,
    );
  });

  it("does not create new session files and rejects unreadable or unsupported history", async () => {
    expect(await readActiveSkillHistory(file)).toEqual([]);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(file, "broken");
    await expect(readActiveSkillHistory(file)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ type: "session", version: 2 }));
    await expect(readActiveSkillHistory(file)).rejects.toThrow();
    await expect(readActiveSkillHistory(directory)).rejects.toThrow();
  });
});
