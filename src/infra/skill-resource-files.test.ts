import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { syncSkillResourceFiles } from "./skill-resource-files.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("writes nested resources, updates content and removes only managed stale files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-resource-test-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "keep.txt"), "unmanaged");
  await syncSkillResourceFiles(root, [
    { path: "references/a.md", mediaType: "text/markdown", content: "first" },
  ]);
  await syncSkillResourceFiles(root, [
    { path: "references/a.md", mediaType: "text/markdown", content: "second" },
  ]);
  expect(await fs.readFile(path.join(root, "references/a.md"), "utf8")).toBe("second");
  if (process.platform !== "win32") {
    expect((await fs.stat(path.join(root, "references/a.md"))).mode & 0o111).toBe(0);
  }
  await syncSkillResourceFiles(root, []);
  await syncSkillResourceFiles(root, []);
  await expect(fs.stat(path.join(root, "references/a.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("unmanaged");
});
it("does not write through a linked resource directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-resource-link-"));
  roots.push(root);
  const base = path.join(root, "skill");
  const outside = path.join(root, "outside");
  await fs.mkdir(base);
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(base, "references"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    syncSkillResourceFiles(base, [
      { path: "references/a.md", mediaType: "text/markdown", content: "x" },
    ]),
  ).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});

it("handles case-only renames without deleting the current attachment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-resource-case-"));
  roots.push(root);
  await syncSkillResourceFiles(root, [
    { path: "Guide.md", mediaType: "text/markdown", content: "old" },
  ]);
  await syncSkillResourceFiles(root, [
    { path: "guide.md", mediaType: "text/markdown", content: "new" },
  ]);
  expect(await fs.readFile(path.join(root, "guide.md"), "utf8")).toBe("new");
});

it("rejects corrupt ownership manifests instead of deleting unverified paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-resource-corrupt-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "keep.txt"), "keep");
  await fs.writeFile(path.join(root, ".openclaw-resource-files.json"), "{}");
  await expect(syncSkillResourceFiles(root, [])).rejects.toThrow("Invalid resource manifest");
  expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep");
});
