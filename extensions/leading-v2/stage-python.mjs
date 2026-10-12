// Run after the repository build when deploying only dist/ rather than this source plugin.
import { cp, mkdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3) {
  throw new Error("Usage: node stage-python.mjs <built-leading-v2-directory>");
}
const source = fileURLToPath(new URL("./python/", import.meta.url));
const target = join(resolve(process.argv[2]), "python");
if (resolve(source) === resolve(target)) {
  throw new Error("Source and destination must differ");
}
await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (file) =>
    !file.includes("__pycache__") && (!extname(file) || [".py", ".txt"].includes(extname(file))),
});
console.log(`Python runtime staged at ${target}`);
