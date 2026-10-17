import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveLocalConfig } from "./complaint-local-contract.js";
it("ships a verified Android server without Python runtime assets", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const assets: string[] = manifest.openclaw.build.runtimeAssets;
  expect(assets.some((asset) => asset.startsWith("python/"))).toBe(false);
  expect(assets).toContain("assets/uiautomator/u2.jar");
  for (const asset of assets) {
    expect((await readFile(join(root, asset))).length).toBeGreaterThan(0);
  }
  expect(
    createHash("sha256")
      .update(await readFile(join(root, "assets/uiautomator/u2.jar")))
      .digest("hex"),
  ).toBe("0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6");
  const config = resolveLocalConfig(
    { complaintExecution: { python: "nonexistent-python", runtimeDir: root, headless: true } },
    root,
  );
  expect(config).not.toHaveProperty("python");
  expect(config).not.toHaveProperty("runtimeDir");
  expect(config.assetsDir).toBe(join(root, "assets"));
});
