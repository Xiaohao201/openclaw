import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
let release: string;
let temporary: string;
let preload: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smoke-test-"));
  release = path.join(root, "release with spaces");
  temporary = path.join(root, "temporary");
  preload = path.join(root, "windows-link-policy.mjs");
  await fs.mkdir(temporary);
  await fs.mkdir(path.join(release, "dist/extensions/example"), { recursive: true });
  await fs.writeFile(path.join(release, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    path.join(release, "dist/extensions/example/package.json"),
    JSON.stringify({ openclaw: { channel: { id: "example" }, extensions: ["./index.js"] } }),
  );
  await fs.writeFile(
    path.join(release, "dist/extensions/example/index.js"),
    'export default { kind: "bundled-channel-entry", loadChannelPlugin: () => ({ id: "example" }) };',
  );
  await fs.writeFile(
    preload,
    `import fs from "node:fs";
Object.defineProperty(process, "platform", { value: "win32" });
const original = fs.symlinkSync;
fs.symlinkSync = (target, destination, type) => {
  if (type !== "junction" || process.env.SMOKE_REJECT_LINK === "1") {
    throw Object.assign(new Error("no symlink privilege"), { code: "EPERM" });
  }
  return original(target, destination, type);
};`,
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function runSmoke(rejectLink = false) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      path.resolve("scripts/test-built-bundled-channel-entry-smoke.mjs"),
      "--package-root",
      release,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        TMP: temporary,
        TEMP: temporary,
        TMPDIR: temporary,
        OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT: "",
        SMOKE_REJECT_LINK: rejectLink ? "1" : "0",
      },
    },
  );
}

it("checks an installed layout without Windows symlink privileges and cleans up", async () => {
  const result = runSmoke();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bundled channel entry smoke passed");
  expect(result.stdout).toContain(`${path.sep}node_modules${path.sep}openclaw`);
  expect(await fs.readdir(temporary)).toEqual([]);
  expect(await fs.readFile(path.join(release, "package.json"), "utf8")).toContain("module");
});

it("still rejects broken channel entries and cleans up the installed layout", async () => {
  await fs.writeFile(path.join(release, "dist/extensions/example/index.js"), "export default {};");
  const result = runSmoke();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("channel entry kind mismatch");
  expect(await fs.readdir(temporary)).toEqual([]);
});

it("cleans up when creating the directory link fails", async () => {
  const result = runSmoke(true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("no symlink privilege");
  expect(await fs.readdir(temporary)).toEqual([]);
});
