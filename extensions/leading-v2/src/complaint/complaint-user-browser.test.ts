import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../api.js";
import { ComplaintBatchStore } from "./complaint-batch-store.js";
import { UserBrowserProfiles } from "./complaint-user-browser.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "leading-browser-test-"));
  directories.push(state);
  let config: OpenClawConfig = { gateway: { port: 19001 } };
  const writeConfigFile = vi.fn(async (next: OpenClawConfig) => {
    config = next;
  });
  const runtime = { loadConfig: () => config, writeConfigFile };
  const bindingPath = (user: string) =>
    join(new ComplaintBatchStore(() => state).sessionDirectory(user), "browser-binding.json");
  const bind = async (user: string, binding: unknown) => {
    await mkdir(new ComplaintBatchStore(() => state).sessionDirectory(user), { recursive: true });
    await writeFile(bindingPath(user), JSON.stringify(binding));
  };
  return {
    state,
    runtime,
    bindingPath,
    bind,
    profiles: new UserBrowserProfiles(state, runtime),
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

describe("per-user managed browser", () => {
  it("prepares an unbound user's profile without starting Chrome or adopting the host default", async () => {
    const f = await fixture();
    const first = await f.profiles.resolve("alice");
    expect(first.profile).toMatch(/^leading-[a-f0-9]+$/);
    expect(first.binding).toMatchObject({
      version: 1,
      profileDir: join(f.state, "browser", first.profile, "user-data"),
    });
    expect(first.binding.cdpUrl).not.toBe("http://127.0.0.1:19012");
    expect(JSON.parse(await readFile(f.bindingPath("alice"), "utf8"))).toEqual(first.binding);
    await expect(f.profiles.resolve("alice", "openclaw")).resolves.toEqual(first);
    expect(f.runtime.writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent first use and gives different users different directories and ports", async () => {
    const f = await fixture();
    const [a, b, again] = await Promise.all([
      f.profiles.resolve("alice"),
      f.profiles.resolve("bob"),
      f.profiles.resolve("alice"),
    ]);
    expect(a).toEqual(again);
    expect(a.profile).not.toBe(b.profile);
    expect(a.binding.profileDir).not.toBe(b.binding.profileDir);
    expect(a.binding.cdpUrl).not.toBe(b.binding.cdpUrl);
    expect(Object.keys(f.runtime.loadConfig().browser?.profiles ?? {})).toHaveLength(2);
  });

  it("restores all reserved profiles after the local debug temporary config is recreated", async () => {
    const f = await fixture();
    const a = await f.profiles.resolve("alice");
    const b = await f.profiles.resolve("bob");
    f.setConfig({ gateway: { port: 19001 } });
    const restarted = new UserBrowserProfiles(f.state, f.runtime);
    const c = await restarted.resolve("carol");
    await expect(restarted.resolve("alice")).resolves.toEqual(a);
    await expect(restarted.resolve("bob")).resolves.toEqual(b);
    expect([a.binding.cdpUrl, b.binding.cdpUrl]).not.toContain(c.binding.cdpUrl);
  });

  it("preserves an existing operator binding and selects its matching nondefault profile", async () => {
    const f = await fixture();
    f.setConfig({ browser: { profiles: { approved: { cdpPort: 19100, color: "#123456" } } } });
    const binding = {
      version: 1,
      cdpUrl: "http://127.0.0.1:19100",
      profileDir: join(f.state, "approved"),
    };
    await f.bind("alice", binding);
    await expect(f.profiles.resolve("alice")).resolves.toEqual({ profile: "approved", binding });
    expect(f.runtime.writeConfigFile).not.toHaveBeenCalled();
    await expect(f.profiles.resolve("alice", "openclaw")).rejects.toThrow("不一致");
  });

  it("rejects another user's profile without changing the account binding", async () => {
    const f = await fixture();
    const a = await f.profiles.resolve("alice");
    const b = await f.profiles.resolve("bob");
    await expect(f.profiles.resolve("alice", b.profile)).rejects.toThrow("不一致");
    await expect(f.profiles.resolve("alice")).resolves.toEqual(a);
  });

  it("does not replace corrupt operator bindings with a fresh account", async () => {
    const f = await fixture();
    await f.bind("alice", { version: 99 });
    await expect(f.profiles.resolve("alice")).rejects.toThrow("绑定文件");
    expect(f.runtime.writeConfigFile).not.toHaveBeenCalled();
  });

  it("fails closed if a reserved endpoint is reassigned to a different profile", async () => {
    const f = await fixture();
    const a = await f.profiles.resolve("alice");
    f.setConfig({
      browser: { profiles: { foreign: { cdpUrl: String(a.binding.cdpUrl), color: "#123456" } } },
    });
    await expect(f.profiles.resolve("alice")).rejects.toThrow("冲突");
  });

  it("does not silently accept a changed managed binding", async () => {
    const f = await fixture();
    const a = await f.profiles.resolve("alice");
    await f.bind("alice", { ...a.binding, cdpUrl: "http://127.0.0.1:19199" });
    await expect(f.profiles.resolve("alice")).rejects.toThrow("不一致");
  });

  it("rejects duplicate endpoints even when the managed profile is still configured", async () => {
    const f = await fixture();
    const a = await f.profiles.resolve("alice");
    const cfg = f.runtime.loadConfig();
    f.setConfig({
      ...cfg,
      browser: {
        ...cfg.browser,
        profiles: {
          ...cfg.browser?.profiles,
          aaa: { cdpUrl: String(a.binding.cdpUrl), color: "#123456" },
        },
      },
    });
    await expect(f.profiles.resolve("alice")).rejects.toThrow("冲突");
  });

  it("keeps approved existing-session Chrome bindings", async () => {
    const f = await fixture();
    const profileDir = join(f.state, "approved-chrome");
    await mkdir(profileDir);
    f.setConfig({
      browser: {
        defaultProfile: "approved",
        profiles: {
          approved: { driver: "existing-session", userDataDir: profileDir, color: "#123456" },
        },
      },
    });
    const binding = { version: 2, driver: "existing-session", profileDir };
    await f.bind("alice", binding);
    await expect(f.profiles.resolve("alice")).resolves.toEqual({ profile: "approved", binding });
    expect(f.runtime.writeConfigFile).not.toHaveBeenCalled();
  });

  it("resumes setup after a config write failure without publishing a binding early", async () => {
    const f = await fixture();
    f.runtime.writeConfigFile.mockRejectedValueOnce(new Error("disk failure"));
    await expect(f.profiles.resolve("alice")).rejects.toThrow("disk failure");
    await expect(readFile(f.bindingPath("alice"))).rejects.toMatchObject({ code: "ENOENT" });
    const a = await f.profiles.resolve("alice");
    expect(a.profile).toMatch(/^leading-/);
    expect(JSON.parse(await readFile(f.bindingPath("alice"), "utf8"))).toEqual(a.binding);
  });
});
