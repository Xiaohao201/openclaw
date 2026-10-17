import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page, Route } from "playwright-core";
import { expect, it, vi } from "vitest";
import { acquireComplaintPage, allowBrowserRequest } from "./session.runtime.js";
const resolveHost = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("openclaw/plugin-sdk/browser-security-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolveHost,
}));
it("rejects a missing handoff before connecting", async () => {
  const connect = vi.fn();
  await expect(acquireComplaintPage({ allowFakeIp: false }, { connect })).rejects.toMatchObject({
    code: "BROWSER_HANDOFF_REQUIRED",
  });
  expect(connect).not.toHaveBeenCalled();
});
it("rejects non-web schemes and credentials, and propagates only the configured Fake-IP policy", async () => {
  expect(await allowBrowserRequest("file:///private", false)).toBe(false);
  expect(await allowBrowserRequest("https://user:pass@example.test", false)).toBe(false);
  expect(await allowBrowserRequest("https://example.test", true)).toBe(true);
  expect(resolveHost).toHaveBeenLastCalledWith("example.test", {
    policy: { allowRfc2544BenchmarkRange: true },
  });
  resolveHost.mockRejectedValueOnce(new Error("private address"));
  expect(await allowBrowserRequest("http://127.0.0.1/", false)).toBe(false);
});

it.each([
  "success",
  "missing_marker",
  "duplicate_marker",
  "wrong_target",
  "ambiguous_context",
  "connect_error",
  "bad_discovery",
  "oversize_discovery",
] as const)("cleans up a version-2 lease: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "native-lease-"));
  const marker = randomUUID();
  const targetId = "fixture-target";
  const page = {
    evaluate: vi.fn().mockResolvedValue(scenario === "missing_marker" ? "wrong" : marker),
    isClosed: vi.fn().mockReturnValue(false),
    route: vi.fn(async (_pattern: string, _handler: (route: Route) => Promise<void>) => {}),
    unroute: vi.fn().mockResolvedValue(undefined),
    context: () => context,
  };
  const context = {
    route: vi.fn(async (_pattern: string, _handler: (route: Route) => Promise<void>) => {}),
    unroute: vi.fn().mockResolvedValue(undefined),
    pages: () => (scenario === "duplicate_marker" ? [page, page] : [page]),
    newCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({
        targetInfo: { targetId: scenario === "wrong_target" ? "different" : targetId },
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const browser = {
    contexts: () => (scenario === "ambiguous_context" ? [context, context] : [context]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const connect = vi.fn().mockResolvedValue(browser as unknown as Browser);
  if (scenario === "connect_error") {
    connect.mockRejectedValue(new Error("connection refused"));
  }
  try {
    await writeFile(
      join(root, "DevToolsActivePort"),
      scenario === "bad_discovery"
        ? "invalid"
        : scenario === "oversize_discovery"
          ? "x".repeat(4097)
          : "18801\n/devtools/browser/fixture",
    );
    const promise = acquireComplaintPage(
      {
        allowFakeIp: false,
        handoff: {
          version: 1,
          marker,
          targetId,
          binding: { version: 2, driver: "existing-session", profileDir: root },
        },
      },
      { connect },
    );
    if (scenario === "success") {
      const lease = await promise;
      expect(lease.page).toBe(page as unknown as Page);
      const popupGuard = context.route.mock.calls[0][1];
      const fallback = vi.fn();
      const abort = vi.fn();
      const popup = { opener: async () => page };
      const route = (candidate: unknown) =>
        ({
          request: () => ({
            frame: () => ({ page: () => candidate }),
            url: () => "http://127.0.0.1/private",
          }),
          fallback,
          abort,
        }) as unknown as Route;
      resolveHost.mockRejectedValueOnce(new Error("private address"));
      await popupGuard(route(popup));
      expect(abort).toHaveBeenCalledWith("blockedbyclient");
      await popupGuard(route({ opener: async () => null }));
      await popupGuard(route(page));
      expect(fallback).toHaveBeenCalledTimes(2);
      await lease.release();
      await lease.release();
      expect(browser.close).toHaveBeenCalledOnce();
      expect(page.unroute).toHaveBeenCalledOnce();
      expect(context.unroute).toHaveBeenCalledOnce();
    } else {
      await expect(promise).rejects.toThrow();
    }
    await expect(readFile(join(root, ".openclaw-complaint.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
