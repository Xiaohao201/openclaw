import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mjs";
import { copyPluginRuntimeAssets } from "../../scripts/copy-plugin-runtime-assets.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("plugin runtime assets", () => {
  it("stages declared runtime files through the normal metadata build", async () => {
    const root = createTempDir("plugin-assets-build-");
    const pluginDir = path.join(root, "extensions", "fixture-runtime");
    await fs.mkdir(path.join(pluginDir, "python"), { recursive: true });
    await fs.writeFile(path.join(pluginDir, "python", "runner.py"), "# runtime fixture");
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "fixture-runtime" }),
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/fixture-runtime",
        openclaw: { extensions: ["./index.ts"], build: { runtimeAssets: ["python/runner.py"] } },
      }),
    );
    copyBundledPluginMetadata({ repoRoot: root });
    expect(
      await fs.readFile(
        path.join(root, "dist", "extensions", "fixture-runtime", "python", "runner.py"),
        "utf8",
      ),
    ).toBe("# runtime fixture");
  });

  it("copies only declared files with their package layout", async () => {
    const pluginDir = createTempDir("plugin-assets-source-");
    const distPluginDir = createTempDir("plugin-assets-dist-");
    await fs.mkdir(path.join(pluginDir, "runtime"));
    await fs.writeFile(path.join(pluginDir, "runtime", "runner.py"), "print('fixture')");
    await fs.writeFile(path.join(pluginDir, "runtime", "private.txt"), "not shipped");
    copyPluginRuntimeAssets({
      pluginDir,
      distPluginDir,
      packageJson: {
        openclaw: { build: { runtimeAssets: ["runtime/runner.py"] } },
      },
    });
    expect(await fs.readFile(path.join(distPluginDir, "runtime", "runner.py"), "utf8")).toBe(
      "print('fixture')",
    );
    expect(await fs.readdir(path.join(distPluginDir, "runtime"))).toEqual(["runner.py"]);
  });

  it.each(["../outside.py", "runtime/../../outside.py", "C:\\outside.py", "missing.py", "."])(
    "fails closed for invalid or absent asset %s",
    (asset) => {
      const pluginDir = createTempDir("plugin-assets-invalid-");
      const distPluginDir = createTempDir("plugin-assets-target-");
      expect(() =>
        copyPluginRuntimeAssets({
          pluginDir,
          distPluginDir,
          packageJson: {
            openclaw: { build: { runtimeAssets: [asset] } },
          },
        }),
      ).toThrow();
    },
  );
});
