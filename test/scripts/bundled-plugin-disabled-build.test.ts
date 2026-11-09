import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mjs";
import {
  listBundledPluginBuildEntries,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { stageBundledPluginRuntimeDeps } from "../../scripts/stage-bundled-plugin-runtime-deps.mjs";

let root: string | undefined;
afterEach(() => {
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("disabled bundled plugin builds", () => {
  it("excludes opted-out plugins before runtime dependency staging while preserving source", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundle-disabled-"));
    for (const id of ["disabled-channel", "enabled-channel"]) {
      const directory = path.join(root, "extensions", id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "index.ts"), "export default {};\n");
      fs.writeFileSync(path.join(directory, "openclaw.plugin.json"), JSON.stringify({ id }));
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: `@openclaw/${id}`,
          version: "1.0.0",
          ...(id === "disabled-channel"
            ? { dependencies: { "uninstalled-dependency": "1.0.0" } }
            : {}),
          openclaw: {
            extensions: ["./index.ts"],
            install: { npmSpec: `@openclaw/${id}` },
            bundle: {
              ...(id === "disabled-channel" ? { enabled: false } : {}),
              stageRuntimeDependencies: true,
            },
          },
        }),
      );
    }
    const params = { cwd: root, env: { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "1" } };
    expect(listBundledPluginBuildEntries(params)).toEqual({
      "extensions/enabled-channel/index": "extensions/enabled-channel/index.ts",
    });
    expect(listBundledPluginPackArtifacts(params)).not.toContain(
      "dist/extensions/disabled-channel/package.json",
    );
    // A rebuild must remove stale output before the staging step sees it.
    const stale = path.join(root, "dist/extensions/disabled-channel");
    fs.mkdirSync(stale, { recursive: true });
    fs.copyFileSync(
      path.join(root, "extensions/disabled-channel/package.json"),
      path.join(stale, "package.json"),
    );
    copyBundledPluginMetadata(params);
    expect(() => stageBundledPluginRuntimeDeps(params)).not.toThrow();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(root, "dist/extensions/enabled-channel/package.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, "extensions/disabled-channel/index.ts"))).toBe(true);
  });
});
