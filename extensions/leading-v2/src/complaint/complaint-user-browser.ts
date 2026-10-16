import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserProfile,
} from "openclaw/plugin-sdk/browser-profiles";
import { z } from "zod";
import type { OpenClawPluginApi } from "../../api.js";
import { ComplaintBatchStore } from "./complaint-batch-store.js";

const bindingSchema = z.union([
  z
    .object({
      version: z.literal(2),
      driver: z.literal("existing-session"),
      profileDir: z.string(),
      allowRfc2544BenchmarkRange: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      cdpUrl: z.string(),
      profileDir: z.string(),
      allowRfc2544BenchmarkRange: z.boolean().optional(),
    })
    .strict(),
]);
const reservationsSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(
      z.string().regex(/^leading-[a-f0-9]{56}$/),
      z.number().int().min(1).max(65535),
    ),
  })
  .strict();
type Binding = z.infer<typeof bindingSchema>;
export type UserBrowserIdentity = { profile: string; binding: Binding };
type ConfigRuntime = OpenClawPluginApi["runtime"]["config"];
const pending = new Map<string, Promise<unknown>>();

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export function defaultChromeDirectory() {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  return join(homedir(), ".config", "google-chrome");
}

async function matchesBinding(profile: ResolvedBrowserProfile, binding: Binding) {
  if (!profile.cdpIsLoopback) {
    return false;
  }
  if (binding.version === 1) {
    return (
      profile.driver === "openclaw" &&
      profile.cdpUrl.replace(/\/$/, "") === binding.cdpUrl.replace(/\/$/, "")
    );
  }
  return (
    profile.driver === "existing-session" &&
    (await realpath(profile.userDataDir ?? defaultChromeDirectory())) ===
      (await realpath(binding.profileDir))
  );
}

/** Provision through the public config contract; the browser plugin owns launching Chrome. */
export class UserBrowserProfiles {
  constructor(
    private readonly state: string,
    private readonly config: ConfigRuntime,
  ) {}

  resolve(userId: string, requested?: string): Promise<UserBrowserIdentity> {
    // Serialize allocation and config writes across users and registry instances in this gateway.
    const previous = pending.get(this.state) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.resolveLocked(userId, requested));
    pending.set(this.state, next);
    void next
      .finally(() => {
        if (pending.get(this.state) === next) {
          pending.delete(this.state);
        }
      })
      .catch(() => undefined);
    return next;
  }

  private async resolveLocked(userId: string, requested?: string): Promise<UserBrowserIdentity> {
    const name = `leading-${createHash("sha256").update(userId).digest("hex").slice(0, 56)}`;
    const profileDir = join(this.state, "browser", name, "user-data");
    const bindingPath = join(
      new ComplaintBatchStore(() => this.state).sessionDirectory(userId),
      "browser-binding.json",
    );
    let binding: Binding | undefined;
    try {
      const raw = await readJson(bindingPath);
      binding = raw === undefined ? undefined : bindingSchema.parse(raw);
    } catch {
      throw new Error("当前用户的浏览器绑定文件无法读取或格式无效，请修复后重试。");
    }
    const managed = !binding || binding.profileDir === profileDir;
    let cfg = this.config.loadConfig();
    let resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (managed) {
      // `openclaw` is the tool's documented default, scoped here to the current user.
      if (requested && requested !== name && requested !== "openclaw") {
        throw new Error("当前 browser profile 与此用户的浏览器不一致。");
      }
      const registryPath = join(this.state, "leading-v2-browser-profiles.json");
      const raw = await readJson(registryPath);
      const reservations = reservationsSchema.parse(raw ?? { version: 1, profiles: {} });
      const profiles = { ...cfg.browser?.profiles };
      const usedPorts = new Map<number, Set<string>>();
      for (const key of Object.keys(resolved.profiles).toSorted()) {
        const profile = resolveProfile(resolved, key);
        if (profile?.driver === "openclaw") {
          const owners = usedPorts.get(profile.cdpPort) ?? new Set<string>();
          owners.add(key);
          usedPorts.set(profile.cdpPort, owners);
        }
      }
      let changed = false;
      // Rehydrate all reservations: suheng:debug intentionally uses a temporary config.
      for (const key of Object.keys(reservations.profiles).toSorted()) {
        const port = reservations.profiles[key];
        const existing = resolveProfile(resolved, key);
        const expectedUrl = `http://127.0.0.1:${port}`;
        if (
          [...(usedPorts.get(port) ?? [])].some((owner) => owner !== key) ||
          (existing &&
            (existing.driver !== "openclaw" ||
              existing.attachOnly ||
              existing.cdpUrl !== expectedUrl))
        ) {
          throw new Error("用户浏览器配置或调试端口发生冲突，请检查配置后重试。");
        }
        usedPorts.set(port, new Set([key]));
        if (!existing) {
          profiles[key] = { cdpUrl: expectedUrl, color: "#0066CC" };
          changed = true;
        }
      }
      let port = reservations.profiles[name];
      if (port === undefined) {
        // Never adopt a pre-existing profile just because its name matches the user hash.
        if (resolved.profiles[name] || binding) {
          throw new Error("用户浏览器分配记录缺失或与现有配置冲突。");
        }
        port = resolved.cdpPortRangeStart;
        while (usedPorts.has(port) && port <= resolved.cdpPortRangeEnd) {
          port++;
        }
        if (port > resolved.cdpPortRangeEnd) {
          throw new Error("没有可用的用户浏览器调试端口。");
        }
        reservations.profiles[name] = port;
        profiles[name] = { cdpUrl: `http://127.0.0.1:${port}`, color: "#0066CC" };
        // Persist the reservation before config/binding so interrupted setup can resume safely.
        await saveJson(registryPath, reservations);
        changed = true;
      }
      if (changed) {
        cfg = { ...cfg, browser: { ...cfg.browser, profiles } };
        await this.config.writeConfigFile(cfg);
        resolved = resolveBrowserConfig(cfg.browser, cfg);
      }
      if (!binding) {
        binding = {
          version: 1,
          cdpUrl: `http://127.0.0.1:${port}`,
          profileDir,
          ...(resolved.ssrfPolicy?.allowRfc2544BenchmarkRange
            ? { allowRfc2544BenchmarkRange: true }
            : {}),
        };
        await saveJson(bindingPath, binding);
      }
      const profile = resolveProfile(resolved, name);
      if (!profile || !(await matchesBinding(profile, binding))) {
        throw new Error("当前 browser profile 与此用户绑定的账号不一致。");
      }
      return { profile: name, binding };
    }

    // Explicit operator bindings keep their account; no fallback to a fresh profile on mismatch.
    const candidates = requested
      ? [requested]
      : [...new Set([resolved.defaultProfile, ...Object.keys(resolved.profiles).toSorted()])];
    for (const candidate of candidates) {
      const profile = resolveProfile(resolved, candidate);
      if (profile && (await matchesBinding(profile, binding!))) {
        return { profile: candidate, binding: binding! };
      }
    }
    throw new Error("当前 browser profile 与此用户绑定的账号不一致。");
  }
}
