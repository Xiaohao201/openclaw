import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { resolveBrowserControlAuth } from "openclaw/plugin-sdk/browser-control-auth";
import { resolveBrowserConfig, resolveProfile } from "openclaw/plugin-sdk/browser-profiles";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { z } from "zod";
import type { OpenClawPluginApi } from "../../api.js";
import {
  loginStorageSchema,
  SharedBrowserLoginStore,
  SharedLoginSourceUnavailable,
} from "./complaint-shared-login.js";
export { SharedLoginSourceUnavailable } from "./complaint-shared-login.js";
import { applyBrowserStorage, withStoragePage } from "./complaint-shared-login-storage.js";
import { defaultChromeDirectory } from "./complaint-user-browser.js";

const managedBinding = z.object({
  version: z.literal(1),
  cdpUrl: z.string(),
  profileDir: z.string(),
});
type Identity = { profile: string; binding: Record<string, unknown> };
type RuntimeDeps = {
  start: (api: OpenClawPluginApi, profile: string) => Promise<void>;
  connect: (endpoint: string) => Promise<Browser>;
  source: (api: OpenClawPluginApi) => {
    profile: string;
    key: string;
    endpoint: () => Promise<string>;
  };
};

// Fixed loopback endpoints only, with no environment proxy or redirects. Credentials
// are used for the browser control API, never for website or CDP requests.
async function requestJson(
  url: URL,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Browser endpoint unavailable"));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 65536) {
          req.destroy(new Error("Browser response too large"));
        }
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Invalid browser response"));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Browser request timed out")), timeoutMs);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end();
  });
}

const defaults: RuntimeDeps = {
  async start(api, profile) {
    const cfg = api.runtime.config.loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (!resolved.enabled) {
      throw new Error("Browser disabled");
    }
    const auth = resolveBrowserControlAuth(cfg);
    const headers: Record<string, string> = {};
    if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    } else if (auth.password) {
      headers["x-openclaw-password"] = auth.password;
    }
    const url = new URL(`http://127.0.0.1:${resolved.controlPort}/start`);
    url.searchParams.set("profile", profile);
    const response = await requestJson(url, "POST", headers, 30_000);
    z.object({ ok: z.literal(true), profile: z.literal(profile) }).parse(response);
  },
  async connect(endpoint) {
    if (endpoint.startsWith("ws:")) {
      const url = new URL(endpoint);
      if (
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("Invalid default browser websocket");
      }
      return await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    }
    const version = z
      .object({ webSocketDebuggerUrl: z.string() })
      .parse(await requestJson(new URL("/json/version", endpoint), "GET"));
    const websocket = new URL(version.webSocketDebuggerUrl);
    const expected = new URL(endpoint);
    if (
      websocket.protocol !== "ws:" ||
      websocket.hostname !== "127.0.0.1" ||
      websocket.port !== expected.port ||
      websocket.username ||
      websocket.password
    ) {
      throw new Error("Invalid managed browser websocket");
    }
    return await chromium.connectOverCDP(websocket.href, { timeout: 10_000 });
  },
  source(api) {
    const cfg = api.runtime.config.loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const source = resolveProfile(resolved, resolved.defaultProfile);
    if (!source || !source.cdpIsLoopback) {
      throw new Error("Default browser must be local");
    }
    const directory = source.userDataDir ?? defaultChromeDirectory();
    return {
      profile: source.name,
      key: `source-${createHash("sha256")
        .update(
          JSON.stringify([
            source.name,
            source.driver,
            source.driver === "existing-session" ? directory : source.cdpUrl,
          ]),
        )
        .digest("hex")
        .slice(0, 56)}`,
      async endpoint() {
        if (source.driver !== "existing-session") {
          const endpoint = new URL(source.cdpUrl);
          if (
            endpoint.protocol !== "http:" ||
            !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
            !endpoint.port ||
            endpoint.username ||
            endpoint.password ||
            endpoint.pathname !== "/" ||
            endpoint.search ||
            endpoint.hash
          ) {
            throw new Error("Invalid default browser endpoint");
          }
          endpoint.hostname = "127.0.0.1";
          return endpoint.href;
        }
        const lines = (await readFile(join(directory, "DevToolsActivePort"), "utf8"))
          .trim()
          .split(/\r?\n/);
        const port = Number(lines[0]);
        if (
          lines.length !== 2 ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535 ||
          !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(lines[1])
        ) {
          throw new Error("Default Chrome remote debugging unavailable");
        }
        return `ws://127.0.0.1:${port}${lines[1]}`;
      },
    };
  },
};

async function readBrowserStorage(browser: Browser, context: BrowserContext) {
  // Fresh CDP connections have no origin history. Register existing tab origins
  // without navigating the user's tabs or sending website requests.
  const origins = [
    ...new Set(
      context.pages().flatMap((page) => {
        try {
          const url = new URL(page.url());
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            ? [url.origin]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ].toSorted();
  if (origins.length === 0) {
    return loginStorageSchema.parse(await context.storageState({ indexedDB: true }));
  }
  return await withStoragePage(browser, context, async (page) => {
    for (const origin of origins) {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 5_000 });
    }
    return loginStorageSchema.parse(await context.storageState({ indexedDB: true }));
  });
}

async function synchronizeEndpoint(
  stateDir: string,
  client: string,
  endpoint: string,
  deps: RuntimeDeps,
  source = false,
) {
  const browser = await deps.connect(endpoint);
  const context = browser.contexts()[0];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!context) {
      throw new Error("Managed browser context unavailable");
    }
    await Promise.race([
      new SharedBrowserLoginStore(stateDir).synchronize(
        client,
        {
          read: async () => readBrowserStorage(browser, context),
          apply: async (state, previous) => applyBrowserStorage(browser, context, state, previous),
        },
        source,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shared browser login timed out")), 20_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // Disconnect the CDP client, leaving Chrome and its tabs running.
    await browser.close();
  }
}

export async function synchronizeSharedBrowserLogin(
  api: OpenClawPluginApi,
  identity: Identity,
  start: boolean,
  deps: RuntimeDeps = defaults,
): Promise<void> {
  const stateDir = api.runtime.state.resolveStateDir();
  const parsed = managedBinding.safeParse(identity.binding);
  // Only profiles automatically provisioned for application users participate.
  // Administrator-bound personal Chrome sessions remain explicit, separate bindings.
  if (
    !/^leading-[a-f0-9]{56}$/.test(identity.profile) ||
    !parsed.success ||
    parsed.data.profileDir !== join(stateDir, "browser", identity.profile, "user-data")
  ) {
    return;
  }
  const endpoint = new URL(parsed.data.cdpUrl);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Invalid managed browser endpoint");
  }
  const source = deps.source(api);
  const initialized = await new SharedBrowserLoginStore(stateDir).hasClient(source.key);
  const syncSource = async () => {
    try {
      if (!initialized && start) {
        await deps.start(api, source.profile);
      }
      await synchronizeEndpoint(stateDir, source.key, await source.endpoint(), deps, true);
    } catch {
      if (!initialized) {
        throw new SharedLoginSourceUnavailable();
      }
      // The durable pool remains usable while the default browser is offline.
      api.logger?.warn(
        "[SHARED_BROWSER_LOGIN] Default browser unavailable; using saved shared login state.",
      );
    }
  };
  if (start || !initialized) {
    await syncSource();
  }
  if (start) {
    await deps.start(api, identity.profile);
  }
  await synchronizeEndpoint(stateDir, identity.profile, endpoint.href, deps);
  if (!start) {
    await syncSource();
  }
}
