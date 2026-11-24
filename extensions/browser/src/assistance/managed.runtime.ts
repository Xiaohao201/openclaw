import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { loadConfig } from "openclaw/plugin-sdk/browser-config-runtime";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "../browser/bridge-server.js";
import { resolveOpenClawUserDataDir, stopOpenClawChrome } from "../browser/chrome.js";
import { resolveBrowserConfig } from "../browser/config.js";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Cannot allocate browser port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Private bridge and profile: neither is added to the shared config or registry. */
export async function createManagedAssistanceBrowser(locked: () => boolean) {
  const config = loadConfig();
  const resolved = resolveBrowserConfig(config.browser, config);
  if (!resolved.enabled || resolved.attachOnly) {
    throw new Error("Assistance requires a managed local browser");
  }
  const profile = `assist-${randomUUID()}`;
  const cdpPort = await reservePort();
  const bridge = await startBrowserBridgeServer({
    resolved: {
      ...resolved,
      controlPort: 0,
      cdpHost: "127.0.0.1",
      cdpProtocol: "http",
      cdpIsLoopback: true,
      attachOnly: false,
      defaultProfile: profile,
      profiles: { [profile]: { cdpPort, color: resolved.color } },
    },
    authToken: randomBytes(32).toString("hex"),
    isInteractionLocked: locked,
  });
  return {
    baseUrl: bridge.baseUrl,
    profile,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    async dispose() {
      // Drain requests first: a timed-out client may still have a browser launch in flight.
      await stopBrowserBridgeServer(bridge.server);
      // Only stop processes created by this private bridge, never shared profiles.
      for (const state of bridge.state.profiles.values()) {
        if (state.running) {
          await stopOpenClawChrome(state.running);
        }
      }
      const userDataDir = path.resolve(resolveOpenClawUserDataDir(profile));
      if (path.basename(path.dirname(userDataDir)) !== profile || !profile.startsWith("assist-")) {
        throw new Error("Refusing to remove an unowned browser profile");
      }
      await fs.rm(path.dirname(userDataDir), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    },
  };
}
