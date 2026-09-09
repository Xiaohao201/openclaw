import { expect, it, vi } from "vitest";
import {
  readSkillResources,
  replaceSkillResources,
  withSkillTransaction,
} from "./skill-resource-store.js";

it("reads only requested parent IDs, preserves order, and handles pre-migration databases", async () => {
  const execute = vi.fn().mockResolvedValue([
    [
      { skill_id: 1, path: "a.md", media_type: "text/markdown", content: "A" },
      { skill_id: 2, path: "other.md", media_type: "text/markdown", content: "Private" },
    ],
  ]);
  const db = { execute } as Parameters<typeof readSkillResources>[0];
  expect(await readSkillResources(db, [])).toEqual(new Map());
  expect((await readSkillResources(db, [1])).get(1)?.[0].content).toBe("A");
  expect((await readSkillResources(db, [1])).has(2)).toBe(false);
  execute.mockRejectedValueOnce({ code: "ER_NO_SUCH_TABLE" });
  expect(await readSkillResources(db, [1])).toEqual(new Map());
  execute.mockRejectedValueOnce(new Error("offline"));
  await expect(readSkillResources(db, [1])).rejects.toThrow("offline");
});

it("validates all input before deleting old resources", async () => {
  const execute = vi.fn().mockResolvedValue([{}]);
  const db = { execute } as Parameters<typeof replaceSkillResources>[0];
  await expect(replaceSkillResources(db, 1, [{ path: "../bad.md" }])).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await replaceSkillResources(db, 1, [{ path: "a.md", mediaType: "text/markdown", content: "A" }]);
  expect(execute.mock.calls[2][1]).toEqual([1, "a.md", "text/markdown", "A"]);
});

it("commits successful transactions and preserves the original failure when rollback fails", async () => {
  const conn = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn().mockRejectedValue(new Error("connection lost")),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as unknown as Parameters<
    typeof withSkillTransaction
  >[0];
  expect(await withSkillTransaction(pool, async () => 7)).toBe(7);
  expect(conn.commit).toHaveBeenCalledOnce();
  await expect(
    withSkillTransaction(pool, async () => {
      throw new Error("original");
    }),
  ).rejects.toThrow("original");
  expect(conn.release).toHaveBeenCalledTimes(2);
});
