import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export function resolveCurrentConfig(config: OpenClawConfig): unknown {
  const entry = config.plugins?.entries?.["wechat-group-push"];
  if (config.plugins?.enabled === false || entry?.enabled === false || !entry?.config) {
    throw new Error("WeChat group push is disabled or not configured");
  }
  return entry.config;
}

export async function readCurrentConfig(): Promise<unknown> {
  // Read disk rather than the last valid runtime snapshot: invalid edits must fail closed.
  const { readConfigFileSnapshotForWrite } = await import("openclaw/plugin-sdk/config-runtime");
  const { snapshot } = await readConfigFileSnapshotForWrite();
  if (!snapshot.exists || !snapshot.valid) {
    throw new Error("WeChat group push configuration is missing or invalid; fix it before sending");
  }
  return resolveCurrentConfig(snapshot.config);
}
