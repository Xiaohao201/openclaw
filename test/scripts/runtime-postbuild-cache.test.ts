import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncRuntimePostbuildCached } from "../../scripts/runtime-postbuild-cache.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
function fixture() {
  const cwd = createTempDir("openclaw-runtime-cache-");
  const write = (file: string, contents = "fixture") => {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write("extensions/demo/package.json", "{}");
  write("dist/entry.js");
  const sync = vi.fn(() => {
    write("dist/extensions/demo/index.js");
    write("dist-runtime/extensions/demo/index.js");
    write("dist/demo.runtime.js");
  });
  const run = (options: { force?: boolean; env?: Record<string, string> } = {}) =>
    syncRuntimePostbuildCached({ cwd, env: {}, sync, ...options });
  return { cwd, write, sync, run };
}

describe("runtime preparation cache", () => {
  it("skips unchanged preparation but respects an explicit rebuild", () => {
    const { run, sync } = fixture();
    expect(run()).toEqual({ reused: false });
    expect(run()).toEqual({ reused: true });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(run({ force: true })).toEqual({ reused: false });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it.each([
    "pnpm-lock.yaml",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
    "extensions/demo/package.json",
    "extensions/demo/openclaw.plugin.json",
    "extensions/demo/assets/payload.json",
    "scripts/runtime-postbuild.mjs",
    "dist/entry.js",
    "dist/extensions/demo/index.js",
    "packages/demo/package.json",
  ])("invalidates when %s changes", (file) => {
    const { run, write, sync } = fixture();
    run();
    write(file, "changed fixture content");
    expect(run()).toEqual({ reused: false });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it.each([
    "dist-runtime/extensions/demo/index.js",
    "dist/extensions/demo/index.js",
    "dist/demo.runtime.js",
  ])("repairs a missing output: %s", (file) => {
    const { cwd, run, sync } = fixture();
    run();
    fs.unlinkSync(path.join(cwd, file));
    expect(run()).toEqual({ reused: false });
    expect(fs.existsSync(path.join(cwd, file))).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed sync, even after a prior success", () => {
    const { run, sync } = fixture();
    run();
    sync.mockImplementationOnce(() => {
      throw new Error("sync failed");
    });
    expect(() => run({ force: true })).toThrow("sync failed");
    expect(run()).toEqual({ reused: false });
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("repairs corrupt cache metadata", () => {
    const { run, write } = fixture();
    run();
    write("dist/.runtime-postbuild-cache.json", "not json");
    expect(run()).toEqual({ reused: false });
  });

  it("invalidates when optional build settings change", () => {
    const { run } = fixture();
    run();
    expect(run({ env: { OPENCLAW_BUILD_PRIVATE_QA: "1" } })).toEqual({ reused: false });
    expect(run({ env: { OPENCLAW_BUILD_PRIVATE_QA: "1" } })).toEqual({ reused: true });
  });
});
