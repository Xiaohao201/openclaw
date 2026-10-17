import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.argv.length !== 3) {
  throw new Error("Usage: node check-runtime.mjs <leading-v2-directory>");
}
const root = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8"));
if (manifest.id !== "leading-v2") {
  throw new Error("Unexpected plugin manifest");
}
const assetRoot = join(root, "assets", "uiautomator");
const bytes = await readFile(join(assetRoot, "u2.jar"));
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6"
) {
  throw new Error("Android server checksum mismatch");
}
for (const file of ["LICENSE", "NOTICE.md"]) {
  if (!(await stat(join(assetRoot, file))).isFile()) {
    throw new Error("Missing Android server notice");
  }
}
console.log("Native complaint assets verified; Python is not required.");
