import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "../../api.js";
import type { LoginStorageState } from "./complaint-shared-login.js";
import { synchronizeSharedBrowserLogin } from "./complaint-shared-login.runtime.js";

const transport = vi.hoisted(() => ({
  connect: vi.fn<(...args: unknown[]) => Promise<Browser>>(),
}));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: transport.connect } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    await dispose();
  }
  transport.connect.mockReset();
});
function fakeBrowser(value: string) {
  const fake = {
    state: {
      cookies: value
        ? [
            {
              name: "session",
              value,
              domain: ".weibo.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ]
        : [],
      origins: [],
    } as LoginStorageState,
    context: {
      pages: () => [],
      storageState: async () => structuredClone(fake.state),
      clearCookies: async (filter: { name: string; domain: string; path: string }) => {
        fake.state.cookies = fake.state.cookies.filter(
          (c) => c.name !== filter.name || c.domain !== filter.domain || c.path !== filter.path,
        );
      },
      addCookies: async (cookies: LoginStorageState["cookies"]) => {
        for (const cookie of cookies) {
          fake.state.cookies = fake.state.cookies.filter(
            (c) => c.name !== cookie.name || c.domain !== cookie.domain || c.path !== cookie.path,
          );
          fake.state.cookies.push(cookie);
        }
      },
    },
    browser: { contexts: () => [fake.context], close: vi.fn(async () => {}) },
  };
  return fake;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "login-transport-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const profile = `leading-${"a".repeat(56)}`;
  const starts: string[] = [];
  const credentials: Array<{ path: string; authorization: string | undefined }> = [];
  const listen = async (handler: RequestListener) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return server;
  };
  const port = (server: Server) => (server.address() as AddressInfo).port;
  const sourceBrowser = fakeBrowser("fixture-source-account");
  const targetBrowser = fakeBrowser("old-user-account");
  let sourceStatus = 200;
  let sourceReply: string | undefined;
  const source = await listen((req, res) => {
    credentials.push({ path: req.url!, authorization: req.headers.authorization });
    res.writeHead(sourceStatus);
    res.end(
      sourceReply ??
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port(source)}/devtools/browser/source`,
        }),
    );
  });
  const target = await listen((_req, res) =>
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${port(target)}/devtools/browser/target`,
      }),
    ),
  );
  const control = await listen((req, res) => {
    const name = new URL(req.url!, "http://127.0.0.1").searchParams.get("profile")!;
    starts.push(name);
    credentials.push({ path: "/start", authorization: req.headers.authorization });
    res.end(JSON.stringify({ ok: true, profile: name }));
  });
  const cfg: OpenClawConfig = {
    gateway: { port: port(control) - 2, auth: { mode: "token", token: "fixture-control-token" } },
    browser: {
      defaultProfile: "source",
      profiles: { source: { cdpUrl: `http://127.0.0.1:${port(source)}`, color: "#0066CC" } },
    },
  };
  const api = {
    runtime: { state: { resolveStateDir: () => root }, config: { loadConfig: () => cfg } },
    logger: { warn: vi.fn() },
  } as unknown as OpenClawPluginApi;
  const identity = {
    profile,
    binding: {
      version: 1,
      profileDir: join(root, "browser", profile, "user-data"),
      cdpUrl: `http://127.0.0.1:${port(target)}`,
    },
  };
  transport.connect.mockImplementation(async (url) =>
    String(url).includes(`/source`)
      ? (sourceBrowser.browser as unknown as Browser)
      : (targetBrowser.browser as unknown as Browser),
  );
  return {
    root,
    api,
    cfg,
    identity,
    starts,
    credentials,
    sourceBrowser,
    targetBrowser,
    sourcePort: port(source),
    setReply: (status: number, reply?: string) => {
      sourceStatus = status;
      sourceReply = reply;
    },
  };
}

describe("shared login browser control transport", () => {
  it("imports the configured default account first and sends credentials only to browser control", async () => {
    const f = await fixture();
    await synchronizeSharedBrowserLogin(f.api, f.identity, true);
    expect(f.starts).toEqual(["source", f.identity.profile]);
    expect(f.targetBrowser.state.cookies[0].value).toBe("fixture-source-account");
    expect(
      f.credentials
        .filter((call) => call.path === "/start")
        .every((call) => call.authorization === "Bearer fixture-control-token"),
    ).toBe(true);
    expect(
      f.credentials
        .filter((call) => call.path !== "/start")
        .every((call) => call.authorization === undefined),
    ).toBe(true);
    f.targetBrowser.state.cookies[0].value = "refreshed";
    await synchronizeSharedBrowserLogin(f.api, f.identity, false);
    expect(f.sourceBrowser.state.cookies[0].value).toBe("refreshed");
  });
  it("uses the durable pool if the previously imported default browser goes offline", async () => {
    const f = await fixture();
    await synchronizeSharedBrowserLogin(f.api, f.identity, true);
    f.setReply(503);
    await expect(synchronizeSharedBrowserLogin(f.api, f.identity, true)).resolves.toBeUndefined();
    expect(f.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("using saved shared login"),
    );
  });
  it("fails before selecting a user's old account if the initial source is unavailable", async () => {
    const f = await fixture();
    for (const [status, reply] of [
      [302, ""],
      [200, "not-json"],
      [200, "x".repeat(66000)],
      [200, JSON.stringify({ webSocketDebuggerUrl: "ws://example.org:18800/remote" })],
    ] as const) {
      f.setReply(status, reply);
      await expect(synchronizeSharedBrowserLogin(f.api, f.identity, true)).rejects.toThrow(
        "默认浏览器",
      );
    }
    expect(f.starts).not.toContain(f.identity.profile);
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it("discovers the explicitly configured existing Chrome data directory", async () => {
    const f = await fixture();
    f.cfg.browser!.profiles!.source = {
      driver: "existing-session",
      userDataDir: f.root,
      color: "#0066CC",
    };
    await writeFile(
      join(f.root, "DevToolsActivePort"),
      `${f.sourcePort}\n/devtools/browser/source\n`,
    );
    await synchronizeSharedBrowserLogin(f.api, f.identity, true);
    expect(transport.connect).toHaveBeenCalledWith(
      `ws://127.0.0.1:${f.sourcePort}/devtools/browser/source`,
      { timeout: 10000 },
    );
    expect(f.targetBrowser.state.cookies[0].value).toBe("fixture-source-account");
  });
});
