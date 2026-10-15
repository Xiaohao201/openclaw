import { createConfigIO, getRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  const disk = createConfigIO().loadConfig();
  const runtime = getRuntimeConfigSnapshot();
  if (!runtime) {
    return disk;
  }
  // Profile creation must be visible within the current tool call, before a gateway
  // reload. Keep resolved credentials and runtime security gates from the snapshot.
  return { ...runtime, browser: { ...runtime.browser, profiles: disk.browser?.profiles } };
}
