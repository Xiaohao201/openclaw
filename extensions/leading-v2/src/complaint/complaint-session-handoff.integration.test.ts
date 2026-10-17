import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "../../api.js";
import {
  registerComplaintBrowserHandoff,
  sessionBrowserHandoffs,
} from "./complaint-session-handoff.js";

const context = (id: string) => ({
  agentId: `rabbitmq-${id}`,
  sessionKey: `agent:rabbitmq-${id}:chat:fixture`,
  sessionId: "fixture",
});
const marker = "12345678-1234-1234-1234-123456789abc";
type Hook = (
  event: { toolName: string; params: Record<string, unknown>; result?: unknown; error?: string },
  ctx: ReturnType<typeof context>,
) => Promise<unknown>;

it.each(["absent", "corrupt", "previous-account"])(
  "opens and hands off a user's browser independently of the default login pool: %s",
  async (pool) => {
    const root = await mkdtemp(join(tmpdir(), "independent-login-"));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const poolPath = join(root, "leading-v2-shared-login.json");
    const stored =
      pool === "corrupt"
        ? "broken legacy state"
        : JSON.stringify({
            version: 1,
            groups: {
              "douyin.com": {
                revision: 1,
                state: {
                  cookies: [
                    {
                      name: "session",
                      value: "fixture-old-default-account",
                      domain: ".douyin.com",
                      path: "/",
                      expires: -1,
                      httpOnly: true,
                      secure: true,
                      sameSite: "Lax",
                    },
                  ],
                  origins: [],
                },
              },
            },
            clients: {},
          });
    try {
      if (pool !== "absent") {
        await writeFile(poolPath, stored);
      }
      let config: OpenClawConfig = {
        gateway: { port: port - 2 },
        browser: {
          cdpPortRangeStart: 18880,
          defaultProfile: "default-account",
          profiles: { "default-account": { cdpUrl: `http://127.0.0.1:${port}`, color: "#0066CC" } },
        },
      };
      const hooks = new Map<string, Hook>();
      const api = {
        config,
        on: (name: string, hook: Hook) => {
          hooks.set(name, hook);
        },
        runtime: {
          state: { resolveStateDir: () => root },
          config: {
            loadConfig: () => config,
            writeConfigFile: async (next: OpenClawConfig) => {
              config = next;
            },
          },
        },
        logger: { warn: vi.fn() },
      } as unknown as OpenClawPluginApi;
      registerComplaintBrowserHandoff(api);
      const registry = sessionBrowserHandoffs(api);
      const before = hooks.get("before_tool_call")!;
      const after = hooks.get("after_tool_call")!;
      await expect(
        before({ toolName: "other", params: {} }, context("33")),
      ).resolves.toBeUndefined();
      await expect(
        before({ toolName: "browser", params: { action: "open", target: "node" } }, context("33")),
      ).resolves.toMatchObject({ block: true });
      await expect(
        before({ toolName: "browser", params: { action: "open" } }, context("33")),
      ).resolves.toMatchObject({
        params: { target: "host", profile: expect.stringMatching(/^leading-/) },
      });
      const first = await registry.before(context("33"), {
        action: "open",
        url: "https://www.douyin.com/video/123",
      });
      expect(first).toMatchObject({ target: "host", profile: expect.stringMatching(/^leading-/) });
      expect(first.profile).not.toBe("default-account");
      await after(
        {
          toolName: "browser",
          params: first,
          result: { details: { targetId: "target-1", sessionHandoff: { version: 1, marker } } },
        },
        context("33"),
      );
      await after(
        {
          toolName: "complaint_browser",
          params: { action: "finish" },
          result: { details: { state: "saved" } },
        },
        context("33"),
      );
      await after(
        {
          toolName: "complaint_browser",
          params: { action: "cancel" },
          result: { details: { state: "cancelled" } },
        },
        context("33"),
      );
      const second = await registry.before(context("44"), {
        action: "open",
        url: "https://www.douyin.com/video/123",
      });
      expect(second.profile).not.toBe(first.profile);
      await expect(registry.before(context("44"), { action: "snapshot" })).rejects.toThrow(
        "先用 browser open",
      );
      const lease = await registry.acquire(context("33"));
      expect(lease.handoff).toMatchObject({ targetId: "target-1", marker });
      await expect(registry.before(context("33"), { action: "open" })).rejects.toThrow("完成前");
      lease.release();
      expect(requests).toEqual([]);
      expect(api.logger.warn).not.toHaveBeenCalled();
      if (pool !== "absent") {
        expect(await readFile(poolPath, "utf8")).toBe(stored);
      } else {
        await expect(readFile(poolPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  },
);
