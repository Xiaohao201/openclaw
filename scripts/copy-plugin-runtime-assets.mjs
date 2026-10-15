import fs from "node:fs";
import path from "node:path";

// Optional build metadata: explicit package-relative files, never executable build hooks.
export function copyPluginRuntimeAssets({ pluginDir, distPluginDir, packageJson }) {
  const assets = packageJson?.openclaw?.build?.runtimeAssets;
  if (assets === undefined) {
    return;
  }
  if (!Array.isArray(assets) || assets.some((asset) => typeof asset !== "string")) {
    throw new Error("openclaw.build.runtimeAssets must be an array of relative file paths");
  }
  const root = fs.realpathSync(pluginDir);
  const copies = assets.map((asset) => {
    if (
      !asset ||
      asset.includes("\\") ||
      path.isAbsolute(asset) ||
      asset.split("/").includes("..")
    ) {
      throw new Error(`Invalid runtime asset path: ${asset}`);
    }
    const source = fs.realpathSync(path.join(root, asset));
    const relative = path.relative(root, source);
    if (
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !fs.statSync(source).isFile()
    ) {
      throw new Error(`Runtime asset must be a file inside its plugin: ${asset}`);
    }
    return { source, target: path.join(distPluginDir, asset) };
  });
  for (const { source, target } of copies) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}
