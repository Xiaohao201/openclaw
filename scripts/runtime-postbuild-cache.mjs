import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHE_VERSION = 1;
const CACHE_FILE = "dist/.runtime-postbuild-cache.json";
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".venv", "__pycache__"]);
const INPUT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "node_modules/.modules.yaml",
  "node_modules/.pnpm/lock.yaml",
  "node_modules/.pnpm",
  "src/plugin-sdk/root-alias.cjs",
  "dist/entry.js",
  "dist/channel-catalog.json",
];
const TREES = [
  "extensions",
  "packages",
  "scripts",
  "dist/extensions",
  "dist/plugin-sdk",
  "dist-runtime",
];

// Inspect metadata, not package contents. Never follow directory symlinks into the
// pnpm store: the install metadata and lockfile invalidate the dependency cache.
export function runtimePostbuildFingerprint(cwd, env = process.env) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      CACHE_VERSION,
      process.platform,
      process.arch,
      process.versions.node,
      env.OPENCLAW_BUILD_PRIVATE_QA ?? "",
      env.OPENCLAW_INCLUDE_OPTIONAL_BUNDLED ?? "",
    ]),
  );
  const inspect = (relative, recurse) => {
    const absolute = path.join(cwd, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      hash.update(JSON.stringify([relative, "missing"]));
      return;
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        const resolved = fs.statSync(absolute);
        target = [resolved.size, resolved.mtimeMs];
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        target = "missing";
      }
      hash.update(JSON.stringify([relative, "link", fs.readlinkSync(absolute), target]));
    } else if (stat.isDirectory() && recurse) {
      hash.update(JSON.stringify([relative, "directory"]));
      for (const name of fs.readdirSync(absolute).toSorted()) {
        if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
          continue;
        }
        inspect(`${relative}/${name}`, !SKIP_DIRECTORIES.has(name));
      }
    } else {
      hash.update(JSON.stringify([relative, stat.size, stat.mtimeMs]));
    }
  };
  for (const relative of INPUT_FILES) {
    inspect(relative, false);
  }
  for (const relative of TREES) {
    inspect(relative, true);
  }
  // Root runtime aliases and their hashed targets must also remain intact.
  if (fs.existsSync(path.join(cwd, "dist"))) {
    for (const name of fs.readdirSync(path.join(cwd, "dist")).toSorted()) {
      if (name.endsWith(".js") || name.endsWith(".cjs")) {
        inspect(`dist/${name}`, false);
      }
    }
  }
  return hash.digest("hex");
}

export function syncRuntimePostbuildCached({ cwd, env, force = false, sync }) {
  const cachePath = path.join(cwd, CACHE_FILE);
  if (!force) {
    const fingerprint = runtimePostbuildFingerprint(cwd, env);
    let cached;
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      // Missing or corrupt cache: repair with a full sync.
    }
    if (cached?.version === CACHE_VERSION && cached.fingerprint === fingerprint) {
      return { reused: true };
    }
  }
  // A failed sync must never leave an older success marker usable.
  fs.rmSync(cachePath, { force: true });
  sync();
  const fingerprint = runtimePostbuildFingerprint(cwd, env);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: CACHE_VERSION, fingerprint })}\n`);
    fs.renameSync(temporaryPath, cachePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return { reused: false };
}
