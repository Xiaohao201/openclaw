import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { localPlatforms } from "./complaint-local-contract.js";

const profilePattern = /^(?:leading|source)-[a-f0-9]{56}$/;
const indexedKeySchema = z.object({
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
});
const databaseSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(
    indexedKeySchema.extend({
      name: z.string(),
      autoIncrement: z.boolean(),
      indexes: z.array(
        indexedKeySchema.extend({ name: z.string(), unique: z.boolean(), multiEntry: z.boolean() }),
      ),
      records: z.array(
        z.object({
          key: z.unknown().optional(),
          keyEncoded: z.unknown().optional(),
          value: z.unknown().optional(),
          valueEncoded: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
const cookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
  })
  .passthrough();
const originSchema = z
  .object({
    origin: z.string().url(),
    localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
    indexedDB: z.array(databaseSchema).optional(),
  })
  .passthrough();
export const loginStorageSchema = z.object({
  cookies: z.array(cookieSchema),
  origins: z.array(originSchema),
});
export type LoginStorageState = z.infer<typeof loginStorageSchema>;
type BrowserStorage = {
  read: () => Promise<LoginStorageState>;
  apply: (state: LoginStorageState, previous: LoginStorageState) => Promise<void>;
};
export class SharedLoginSourceUnavailable extends Error {
  constructor() {
    super(
      "默认浏览器的登录态尚未导入。请先启动 pnpm openclaw 的默认浏览器；使用日常 Chrome 时需开启远程调试并允许连接。",
    );
  }
}
const storeSchema = z.object({
  version: z.literal(1),
  groups: z.record(
    z.string(),
    z.object({ revision: z.number().int().positive(), state: loginStorageSchema }),
  ),
  clients: z.record(
    z.string().regex(profilePattern),
    z.record(z.string(), z.number().int().positive()),
  ),
});
const roots = [...new Set(Object.values(localPlatforms).flat())]
  .filter((domain, _, all) => !all.some((parent) => domain.endsWith(`.${parent}`)))
  .toSorted();

function groupForHost(host: string) {
  const normalized = host.toLowerCase().replace(/^\./, "");
  return roots.find((root) => normalized === root || normalized.endsWith(`.${root}`));
}
function groupForOrigin(origin: string) {
  const url = new URL(origin);
  return url.protocol === "https:" && !url.port && !url.username && !url.password
    ? groupForHost(url.hostname)
    : undefined;
}
function canonical(state: LoginStorageState): LoginStorageState {
  return {
    cookies: state.cookies.toSorted((a, b) =>
      JSON.stringify([a.domain, a.path, a.name, a.partitionKey]).localeCompare(
        JSON.stringify([b.domain, b.path, b.name, b.partitionKey]),
      ),
    ),
    origins: state.origins
      .map((origin) => ({
        ...origin,
        localStorage: origin.localStorage.toSorted((a, b) => a.name.localeCompare(b.name)),
      }))
      .toSorted((a, b) => a.origin.localeCompare(b.origin)),
  };
}
function equal(a: LoginStorageState, b: LoginStorageState) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function partition(state: LoginStorageState) {
  const groups = new Map<string, LoginStorageState>();
  const group = (key: string) => {
    let result = groups.get(key);
    if (!result) {
      result = { cookies: [], origins: [] };
      groups.set(key, result);
    }
    return result;
  };
  for (const cookie of state.cookies) {
    const key = groupForHost(cookie.domain);
    if (key && (cookie.expires === -1 || cookie.expires > Date.now() / 1000)) {
      group(key).cookies.push(cookie);
    }
  }
  for (const origin of state.origins) {
    const key = groupForOrigin(origin.origin);
    if (key) {
      group(key).origins.push(origin);
    }
  }
  return groups;
}

/** A deployment-local shared account pool. Task tabs and browser profiles remain user-owned. */
export class SharedBrowserLoginStore {
  constructor(private readonly directory: string) {}

  async hasClient(profile: string): Promise<boolean> {
    try {
      const stored = storeSchema.parse(
        JSON.parse(await readFile(join(this.directory, "leading-v2-shared-login.json"), "utf8")),
      );
      return Object.hasOwn(stored.clients, profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw new Error("Invalid shared login state", { cause: error });
    }
  }

  async synchronize(
    profile: string,
    browser: BrowserStorage,
    initializeEmptyGroups = false,
  ): Promise<void> {
    if (!profilePattern.test(profile)) {
      throw new Error("Invalid managed browser profile");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "leading-v2-shared-login.json");
    const lockPath = `${path}.lock`;
    const deadline = Date.now() + 10_000;
    let lock;
    while (!lock) {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        // A crashed gateway must not leave all future login synchronization blocked.
        const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
              await rm(lockPath, { force: true });
              continue;
            }
          }
        }
        if (Date.now() >= deadline) {
          throw new Error("Shared browser login is busy", { cause: error });
        }
        await delay(50);
      }
    }
    try {
      await lock.writeFile(String(process.pid));
      let stored: z.infer<typeof storeSchema>;
      try {
        if ((await stat(path)).size > 32 * 1024 * 1024) {
          throw new Error("Shared login state is too large");
        }
        stored = storeSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error("Invalid shared login state", { cause: error });
        }
        stored = { version: 1, groups: {}, clients: {} };
      }
      const current = loginStorageSchema.parse(await browser.read());
      const observed = partition(current);
      const revisions = stored.clients[profile] ?? {};
      const acknowledged: Record<string, number> = {};
      for (const key of roots) {
        const existing = stored.groups[key];
        const local = observed.get(key) ?? { cookies: [], origins: [] };
        if (!existing) {
          if (
            !initializeEmptyGroups &&
            !local.cookies.length &&
            !local.origins.some((origin) => origin.localStorage.length || origin.indexedDB?.length)
          ) {
            continue;
          }
          stored.groups[key] = { revision: 1, state: canonical(local) };
        } else if (revisions[key] === existing.revision) {
          // CDP only observes origins visited by this connection. Missing origins are
          // not logout; an observed origin with empty storage is an explicit deletion.
          const origins = new Map(existing.state.origins.map((origin) => [origin.origin, origin]));
          for (const origin of local.origins) {
            origins.set(origin.origin, origin);
          }
          const next = canonical({ cookies: local.cookies, origins: [...origins.values()] });
          if (!equal(next, existing.state)) {
            stored.groups[key] = { revision: existing.revision + 1, state: next };
          }
        }
        // A fresh or stale browser imports the authoritative revision. It must not
        // publish its old account over a more recent login/logout from another user.
        acknowledged[key] = stored.groups[key].revision;
      }
      const shared = Object.entries(stored.groups)
        .filter(([key]) => roots.includes(key))
        .map(([, group]) => group.state);
      // Re-filter persisted records, so a corrupt/edited pool cannot inject private origins.
      const allowed = [
        ...partition({
          cookies: shared.flatMap((g) => g.cookies),
          origins: shared.flatMap((g) => g.origins),
        }).values(),
      ];
      const target = canonical({
        cookies: [
          ...current.cookies.filter((c) => !groupForHost(c.domain)),
          ...allowed.flatMap((g) => g.cookies),
        ],
        origins: [
          ...current.origins.filter((o) => !groupForOrigin(o.origin)),
          ...allowed.flatMap((g) => g.origins),
        ],
      });
      // Publish first, but acknowledge only after the import succeeds. A retry then
      // imports the same revision instead of treating a partial restore as a logout.
      await this.save(path, stored);
      if (!equal(current, target)) {
        await browser.apply(target, current);
      }
      stored.clients[profile] = acknowledged;
      await this.save(path, stored);
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  private async save(path: string, value: z.infer<typeof storeSchema>) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) {
      throw new Error("Shared login state is too large");
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
