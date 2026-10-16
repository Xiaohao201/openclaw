import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { applyBrowserStorage } from "./complaint-shared-login-storage.js";
import { synchronizeSharedBrowserLogin } from "./complaint-shared-login.runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shared-login-runtime-"));
  roots.push(root);
  const profile = `leading-${"a".repeat(56)}`;
  const identity = {
    profile,
    binding: {
      version: 1,
      profileDir: join(root, "browser", profile, "user-data"),
      cdpUrl: "http://127.0.0.1:18801",
    },
  };
  const api = {
    runtime: { state: { resolveStateDir: () => root } },
  } as unknown as OpenClawPluginApi;
  const context = {
    pages: () => [],
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    setStorageState: vi.fn(async () => {}),
  };
  const browser = { contexts: () => [context], close: vi.fn(async () => {}) };
  const deps = {
    start: vi.fn(async () => {}),
    connect: vi.fn(async () => browser as unknown as Browser),
    source: () => ({
      profile: "user",
      key: `source-${"b".repeat(56)}`,
      endpoint: async () => "http://127.0.0.1:18800/",
    }),
  };
  return { identity, api, context, browser, deps };
}
describe("shared login runtime", () => {
  it("preserves surviving cookie partitions when removing an expired partition", async () => {
    const cookie = {
      name: "session",
      value: "fixture",
      domain: ".weibo.com",
      path: "/",
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: "None" as const,
    };
    const keep = { ...cookie, partitionKey: "https://weibo.com" };
    const remove = { ...cookie, partitionKey: "https://weibo.cn" };
    const context = { clearCookies: vi.fn(async () => {}), addCookies: vi.fn(async () => {}) };
    await applyBrowserStorage(
      {} as Browser,
      context as unknown as BrowserContext,
      { cookies: [keep], origins: [] },
      { cookies: [keep, remove], origins: [] },
    );
    expect(context.clearCookies).toHaveBeenCalledOnce();
    expect(context.addCookies).toHaveBeenCalledWith([keep]);
  });
  it("starts only the selected user browser, then disconnects without closing its tabs", async () => {
    const f = await fixture();
    await synchronizeSharedBrowserLogin(f.api, f.identity, true, f.deps);
    expect(f.deps.start).toHaveBeenCalledWith(f.api, f.identity.profile);
    expect(f.deps.connect).toHaveBeenCalledWith("http://127.0.0.1:18801/");
    expect(f.context.storageState).toHaveBeenCalledWith({ indexedDB: true });
    expect(f.browser.close).toHaveBeenCalledTimes(2);
    await synchronizeSharedBrowserLogin(f.api, f.identity, false, f.deps);
    expect(f.deps.start).toHaveBeenCalledTimes(2);
  });
  it("does not share administrator-bound personal browser sessions", async () => {
    const f = await fixture();
    await synchronizeSharedBrowserLogin(f.api, { ...f.identity, profile: "user" }, true, f.deps);
    await synchronizeSharedBrowserLogin(
      f.api,
      { ...f.identity, binding: { ...f.identity.binding, profileDir: join(tmpdir(), "personal") } },
      true,
      f.deps,
    );
    expect(f.deps.start).not.toHaveBeenCalled();
    expect(f.deps.connect).not.toHaveBeenCalled();
  });
  it("rejects redirected, credential-bearing, and remote CDP endpoints", async () => {
    const f = await fixture();
    for (const cdpUrl of [
      "http://example.org:18801",
      "http://127.0.0.1:18801/path",
      "http://user:secret@127.0.0.1:18801",
      "http://127.0.0.1:18801?token=x",
    ]) {
      await expect(
        synchronizeSharedBrowserLogin(
          f.api,
          { ...f.identity, binding: { ...f.identity.binding, cdpUrl } },
          true,
          f.deps,
        ),
      ).rejects.toThrow("Invalid managed browser endpoint");
    }
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("disconnects even when reading browser state fails", async () => {
    const f = await fixture();
    f.context.storageState.mockRejectedValueOnce(new Error("fixture"));
    await expect(synchronizeSharedBrowserLogin(f.api, f.identity, false, f.deps)).rejects.toThrow();
    expect(f.browser.close).toHaveBeenCalledOnce();
  });
});
