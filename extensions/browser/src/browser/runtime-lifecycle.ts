import type { Server } from "node:http";
import { isPwAiLoaded } from "./pw-ai-state.js";
import type { BrowserServerState } from "./server-context.js";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";
import { isBrowserControlManaged } from "./service-handoff.js";

export async function createBrowserRuntimeState(params: {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  };

  await ensureExtensionRelayForProfiles({
    resolved: params.resolved,
    onWarn: params.onWarn,
  });

  return state;
}

export async function stopBrowserRuntime(params: {
  current: BrowserServerState | null;
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  if (!params.current) {
    return;
  }

  await stopKnownBrowserProfiles({
    getState: params.getState,
    onWarn: params.onWarn,
  });

  if (params.closeServer && params.current.server) {
    await new Promise<void>((resolve) => {
      params.current?.server?.close(() => resolve());
    });
  }

  if (!isPwAiLoaded()) {
    params.clearState();
    return;
  }
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch (error) {
    if (isBrowserControlManaged()) {
      throw error;
    }
  }
  params.clearState();
}
