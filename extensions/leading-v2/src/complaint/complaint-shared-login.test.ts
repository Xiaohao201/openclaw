import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedBrowserLoginStore, type LoginStorageState } from "./complaint-shared-login.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const profile = (n: number) => `leading-${String(n).padStart(56, "0")}`;
const cookie = (value: string, domain = ".weibo.com") => ({
  name: "session",
  value,
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
});
function browser(cookies = [cookie("test-account-a")]): {
  state: LoginStorageState;
  read: () => Promise<LoginStorageState>;
  apply: ReturnType<typeof vi.fn<(state: LoginStorageState) => Promise<void>>>;
} {
  const instance = {
    state: { cookies, origins: [] } as LoginStorageState,
    read: async () => structuredClone(instance.state),
    apply: vi.fn(async (state: LoginStorageState) => {
      instance.state = structuredClone(state);
    }),
  };
  return instance;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shared-browser-login-"));
  roots.push(root);
  return { root, store: new SharedBrowserLoginStore(root) };
}

describe("shared platform login with per-user browsers", () => {
  it("uses the default source even when a user's old profile has a different login", async () => {
    const { store } = await fixture();
    const source = `source-${"a".repeat(56)}`;
    expect(await store.hasClient(source)).toBe(false);
    await store.synchronize(source, browser([]), true);
    expect(await store.hasClient(source)).toBe(true);
    const user = browser([cookie("old-private-account")]);
    await store.synchronize(profile(1), user);
    expect(user.state.cookies).toEqual([]);
  });

  it("imports an existing login into new users and preserves unrelated site data", async () => {
    const { store } = await fixture();
    const first = browser();
    first.state.origins.push({
      origin: "https://weibo.com",
      localStorage: [{ name: "login", value: "fixture-token" }],
    });
    const second = browser([cookie("private", ".example.org")]);
    second.state.origins.push({
      origin: "https://example.org",
      localStorage: [{ name: "draft", value: "private" }],
    });
    await store.synchronize(profile(1), first);
    await store.synchronize(profile(2), second);
    expect(second.state.cookies).toEqual(
      expect.arrayContaining([cookie("test-account-a"), cookie("private", ".example.org")]),
    );
    expect(second.state.origins).toEqual(expect.arrayContaining(first.state.origins));
    expect(second.state.origins).toContainEqual({
      origin: "https://example.org",
      localStorage: [{ name: "draft", value: "private" }],
    });
    expect(first.apply).not.toHaveBeenCalled();
  });

  it("propagates login changes and logout without resurrecting a stale user's cookies", async () => {
    const { store } = await fixture();
    const a = browser();
    const b = browser([]);
    await store.synchronize(profile(1), a);
    await store.synchronize(profile(2), b);
    a.state.cookies = [cookie("new-account")];
    await store.synchronize(profile(1), a);
    b.state.cookies = [cookie("stale-refresh")];
    await store.synchronize(profile(2), b);
    expect(b.state.cookies).toEqual([cookie("new-account")]);
    a.state.cookies = [];
    await store.synchronize(profile(1), a);
    await store.synchronize(profile(2), b);
    expect(b.state.cookies).toEqual([]);
    const newcomer = browser([cookie("old-account")]);
    await store.synchronize(profile(3), newcomer);
    expect(newcomer.state.cookies).toEqual([]);
  });

  it("persists revisions across restarts and serializes simultaneous users", async () => {
    const { root, store } = await fixture();
    const a = browser();
    const b = browser([]);
    await Promise.all([store.synchronize(profile(1), a), store.synchronize(profile(2), b)]);
    a.state.cookies = [cookie("refreshed")];
    await new SharedBrowserLoginStore(root).synchronize(profile(1), a);
    await new SharedBrowserLoginStore(root).synchronize(profile(2), b);
    expect(b.state.cookies).toEqual([cookie("refreshed")]);
    expect(a.apply).not.toHaveBeenCalled();
  });

  it("does not mark imports applied when browser storage fails", async () => {
    const { store } = await fixture();
    const a = browser();
    const b = browser([]);
    await store.synchronize(profile(1), a);
    b.apply.mockRejectedValueOnce(new Error("fixture failure"));
    await expect(store.synchronize(profile(2), b)).rejects.toThrow();
    await store.synchronize(profile(2), b);
    expect(b.state.cookies).toEqual(a.state.cookies);
  });

  it("preserves unobserved origins and IndexedDB while sharing platform storage", async () => {
    const { store } = await fixture();
    const a = browser();
    a.state.origins.push({
      origin: "https://weibo.com",
      localStorage: [{ name: "token", value: "fixture" }],
      indexedDB: [{ name: "auth", version: 1, stores: [] }],
    });
    await store.synchronize(profile(1), a);
    a.state.origins = [];
    await store.synchronize(profile(1), a);
    const b = browser([]);
    await store.synchronize(profile(2), b);
    expect(b.state.origins[0]).toMatchObject({
      indexedDB: [{ name: "auth" }],
      localStorage: [{ name: "token", value: "fixture" }],
    });
  });

  it("does not share private domains or suffix lookalikes or accept arbitrary profile paths", async () => {
    const { root, store } = await fixture();
    const a = browser([
      cookie("private", ".evilweibo.com"),
      cookie("private", ".weibo.com.example.org"),
    ]);
    await store.synchronize(profile(1), a);
    expect(await readFile(join(root, "leading-v2-shared-login.json"), "utf8")).not.toContain(
      "private",
    );
    await expect(store.synchronize("../other", a)).rejects.toThrow();
    await writeFile(join(root, "leading-v2-shared-login.json"), "broken");
    await expect(store.synchronize(profile(1), a)).rejects.toThrow();
  });
});
