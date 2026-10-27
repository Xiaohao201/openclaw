import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const artifactManifestName = "openclaw-deploy-artifact.json";
const manifestSchema = z.object({
  format: z.literal(1),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  platform: z.string().min(1),
  arch: z.string().min(1),
  nodeMajor: z.number().int().positive(),
  version: z.string().min(1),
  files: z
    .array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1),
});

async function artifactFiles(root: string): Promise<string[]> {
  const files = ["openclaw.mjs", "package.json", "pnpm-lock.yaml"];
  async function walk(relative: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Artifact cannot contain a symbolic link: ${child}`);
      }
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      } else {
        throw new Error(`Artifact cannot contain a special file: ${child}`);
      }
    }
  }
  const dist = await fs.lstat(path.join(root, "dist"));
  if (!dist.isDirectory() || dist.isSymbolicLink()) {
    throw new Error("Artifact dist must be a real directory");
  }
  await walk("dist");
  for (const required of ["dist/entry.js", "dist/control-ui/index.html"]) {
    if (!files.includes(required)) {
      throw new Error(`Missing built artifact: ${required}`);
    }
  }
  if (!files.some((file) => file.startsWith("dist/control-ui/assets/"))) {
    throw new Error("Missing Control UI assets");
  }
  return files.toSorted();
}

async function hashFile(root: string, relative: string): Promise<string> {
  const file = path.join(root, relative);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Artifact must be a regular file: ${relative}`);
  }
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** Checks built code and UI, not dependency portability or production readiness. */
export async function writeDeployArtifact(root: string, commit: string): Promise<void> {
  const pkg = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")));
  const files = [];
  for (const relative of await artifactFiles(root)) {
    files.push({ path: relative, sha256: await hashFile(root, relative) });
  }
  const manifest = manifestSchema.parse({
    format: 1,
    commit,
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    version: pkg.version,
    files,
  });
  await fs.writeFile(
    path.join(root, artifactManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
}

export async function verifyDeployArtifact(root: string): Promise<void> {
  const manifest = manifestSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, artifactManifestName), "utf8")),
  );
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.nodeMajor !== Number(process.versions.node.split(".")[0])
  ) {
    throw new Error("Artifact runtime platform, architecture, or Node major does not match");
  }
  const actual = await artifactFiles(root);
  const expected = manifest.files.map((file) => file.path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Artifact file list differs from the manifest");
  }
  // Only open paths discovered locally, never arbitrary paths from a manifest.
  for (const [index, relative] of actual.entries()) {
    if ((await hashFile(root, relative)) !== manifest.files[index].sha256) {
      throw new Error(`Artifact checksum mismatch: ${relative}`);
    }
  }
}
