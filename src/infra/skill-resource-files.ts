import fs from "node:fs/promises";
import path from "node:path";
import {
  openFileWithinRoot,
  readFileWithinRoot,
  removePathWithinRoot,
  writeFileWithinRoot,
} from "./fs-safe.js";
import {
  validateResourcePath,
  validateSkillResources,
  type SkillResource,
} from "./skill-resources.js";

const MANIFEST = ".openclaw-resource-files.json";

export async function getManagedResourcePaths(baseDir: string): Promise<string[]> {
  let previous: string[] = [];
  try {
    const file = await readFileWithinRoot({
      rootDir: baseDir,
      relativePath: MANIFEST,
      maxBytes: 32_768,
    });
    const parsed: unknown = JSON.parse(file.buffer.toString("utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid resource manifest");
    }
    previous = parsed.map(validateResourcePath);
  } catch (error) {
    if (
      (error as { code?: string }).code !== "not-found" &&
      (error as { code?: string }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  return previous;
}

/** Only previously managed files are removed; user-created files are untouched. */
export async function syncSkillResourceFiles(
  baseDir: string,
  input: SkillResource[],
): Promise<void> {
  const resources = validateSkillResources(input);
  const base = await fs.lstat(baseDir);
  if (!base.isDirectory() || base.isSymbolicLink()) {
    throw new Error("Invalid skill resource directory");
  }
  const previous = await getManagedResourcePaths(baseDir);
  for (const resource of resources) {
    // Reject directory links even if they happen to resolve inside the skill.
    const segments = resource.path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      try {
        if ((await fs.lstat(path.join(baseDir, ...segments.slice(0, i)))).isSymbolicLink()) {
          throw new Error("Resource symlink is not allowed");
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          throw error;
        }
      }
    }
    await writeFileWithinRoot({
      rootDir: baseDir,
      relativePath: resource.path,
      data: resource.content,
    });
    if (process.platform !== "win32") {
      const opened = await openFileWithinRoot({
        rootDir: baseDir,
        relativePath: resource.path,
        rejectHardlinks: true,
      });
      try {
        await opened.handle.chmod(0o600);
      } finally {
        await opened.handle.close();
      }
    }
  }
  const current = new Set(resources.map((r) => r.path));
  const currentKeys = new Set(
    [...current].map((file) => (process.platform === "win32" ? file.toLowerCase() : file)),
  );
  for (const old of previous) {
    if (!currentKeys.has(process.platform === "win32" ? old.toLowerCase() : old)) {
      try {
        await removePathWithinRoot({ rootDir: baseDir, relativePath: old });
      } catch (error) {
        if (
          (error as { code?: string }).code !== "not-found" &&
          (error as { code?: string }).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }
  await writeFileWithinRoot({
    rootDir: baseDir,
    relativePath: MANIFEST,
    data: JSON.stringify([...current].toSorted()) + "\n",
  });
}
