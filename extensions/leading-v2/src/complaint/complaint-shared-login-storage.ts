import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { LoginStorageState } from "./complaint-shared-login.js";

export async function withStoragePage<T>(
  browser: Browser,
  context: BrowserContext,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const cdp = await browser.newBrowserCDPSession();
  let targetId: string | undefined;
  try {
    const marker = `about:blank#openclaw-login-sync-${randomUUID()}`;
    const ready = context.waitForEvent("page", {
      predicate: (page) => page.url() === marker,
      timeout: 5_000,
    });
    void ready.catch(() => {});
    const target = await cdp.send("Target.createTarget", { url: marker, background: true });
    targetId = target.targetId;
    const page = await ready;
    await page.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "" }),
    );
    return await run(page);
  } finally {
    if (targetId) {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    await cdp.detach().catch(() => {});
  }
}

type Origin = LoginStorageState["origins"][number];
type Database = NonNullable<Origin["indexedDB"]>[number];

// Runs in an offline helper page. Updating records in place preserves open database
// connections, sessionStorage, service workers, and the user's task tabs.
async function restoreOrigin({
  origin,
  databases,
}: {
  origin: Origin;
  databases: Database[] | null;
}) {
  function decode(value: unknown, refs = new Map<number, unknown>()): unknown {
    if (typeof value !== "object" || !value) {
      return value;
    }
    const v = value as Record<string, unknown>;
    if ("ref" in v) {
      return refs.get(Number(v.ref));
    }
    if ("v" in v) {
      switch (v.v) {
        case "undefined":
          return undefined;
        case "null":
          return null;
        case "NaN":
          return NaN;
        case "Infinity":
          return Infinity;
        case "-Infinity":
          return -Infinity;
        case "-0":
          return -0;
        default:
          throw new Error("Unsupported stored value");
      }
    }
    if ("d" in v) {
      return new Date(String(v.d));
    }
    if ("u" in v) {
      return new URL(String(v.u));
    }
    if ("bi" in v) {
      return BigInt(String(v.bi));
    }
    if ("e" in v) {
      const info = v.e as { m: string; n: string; s: string };
      const error = new Error(info.m);
      error.name = info.n;
      error.stack = info.s;
      return error;
    }
    if ("r" in v) {
      const r = v.r as { p: string; f: string };
      return new RegExp(r.p, r.f);
    }
    if ("a" in v) {
      const result: unknown[] = [];
      refs.set(Number(v.id), result);
      for (const item of v.a as unknown[]) {
        result.push(decode(item, refs));
      }
      return result;
    }
    if ("o" in v) {
      const result: Record<string, unknown> = {};
      refs.set(Number(v.id), result);
      for (const item of v.o as Array<{ k: string; v: unknown }>) {
        Object.defineProperty(result, item.k, {
          value: decode(item.v, refs),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    if ("ab" in v || "ta" in v) {
      const data = (v.ab ?? v.ta) as { b: string; k?: string };
      const bytes = Uint8Array.from(atob(data.b), (c) => c.charCodeAt(0));
      if ("ab" in v) {
        return bytes.buffer;
      }
      switch (data.k) {
        case "i8":
          return new Int8Array(bytes.buffer);
        case "ui8":
          return bytes;
        case "ui8c":
          return new Uint8ClampedArray(bytes.buffer);
        case "i16":
          return new Int16Array(bytes.buffer);
        case "ui16":
          return new Uint16Array(bytes.buffer);
        case "i32":
          return new Int32Array(bytes.buffer);
        case "ui32":
          return new Uint32Array(bytes.buffer);
        case "f32":
          return new Float32Array(bytes.buffer);
        case "f64":
          return new Float64Array(bytes.buffer);
        case "bi64":
          return new BigInt64Array(bytes.buffer);
        case "bui64":
          return new BigUint64Array(bytes.buffer);
        default:
          throw new Error("Unsupported stored array");
      }
    }
    throw new Error("Unsupported stored value");
  }
  async function restoreDatabase(info: Database) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(info.name, info.version);
      let failed = false;
      request.onblocked = () => {
        failed = true;
        reject(new Error("Login database upgrade blocked"));
      };
      request.addEventListener("error", () => reject(new Error("Login database unavailable")));
      request.onupgradeneeded = () => {
        if (failed) {
          request.transaction?.abort();
          return;
        }
        for (const store of info.stores) {
          if (request.result.objectStoreNames.contains(store.name)) {
            continue;
          }
          const target = request.result.createObjectStore(store.name, {
            keyPath: store.keyPathArray ?? store.keyPath,
            autoIncrement: store.autoIncrement,
          });
          for (const index of store.indexes) {
            target.createIndex(index.name, index.keyPathArray ?? index.keyPath!, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
      };
      request.onsuccess = () => {
        if (failed) {
          request.result.close();
        } else {
          resolve(request.result);
        }
      };
    });
    try {
      if (!db.objectStoreNames.length) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(db.objectStoreNames, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.addEventListener("abort", () =>
          reject(new Error("Login database update failed")),
        );
        transaction.addEventListener("error", () =>
          reject(new Error("Login database update failed")),
        );
        try {
          for (const name of db.objectStoreNames) {
            transaction.objectStore(name).clear();
          }
          for (const store of info.stores) {
            const target = transaction.objectStore(store.name);
            for (const record of store.records) {
              const value: unknown =
                "valueEncoded" in record ? decode(record.valueEncoded) : record.value;
              const key = "keyEncoded" in record ? decode(record.keyEncoded) : record.key;
              if (key === undefined) {
                target.put(value);
              } else {
                target.put(value, key as IDBValidKey);
              }
            }
          }
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }
  if (databases) {
    const existing = await indexedDB.databases();
    const updates = [...databases];
    for (const db of existing) {
      if (db.name && db.version && !updates.some((item) => item.name === db.name)) {
        updates.push({ name: db.name, version: db.version, stores: [] });
      }
    }
    for (const db of updates) {
      await restoreDatabase(db);
    }
  }
  localStorage.clear();
  for (const item of origin.localStorage) {
    localStorage.setItem(item.name, item.value);
  }
}

export async function applyBrowserStorage(
  browser: Browser,
  context: BrowserContext,
  state: LoginStorageState,
  previous: LoginStorageState,
) {
  const cookieKey = (c: LoginStorageState["cookies"][number]) =>
    JSON.stringify([c.domain, c.path, c.name, c.partitionKey]);
  const desired = new Map(state.cookies.map((c) => [cookieKey(c), c]));
  const cleared = new Set<string>();
  const unpartitionedKey = (c: LoginStorageState["cookies"][number]) =>
    JSON.stringify([c.domain, c.path, c.name]);
  for (const cookie of previous.cookies) {
    if (!desired.has(cookieKey(cookie))) {
      await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
      // clearCookies cannot select a partition. Restore surviving partitions below.
      cleared.add(unpartitionedKey(cookie));
    }
  }
  const existing = new Map(previous.cookies.map((c) => [cookieKey(c), c]));
  const changed = state.cookies.filter(
    (c) =>
      cleared.has(unpartitionedKey(c)) ||
      JSON.stringify(c) !== JSON.stringify(existing.get(cookieKey(c))),
  );
  if (changed.length) {
    await context.addCookies(changed);
  }
  const origins = state.origins.filter(
    (origin) =>
      JSON.stringify(origin) !==
      JSON.stringify(previous.origins.find((o) => o.origin === origin.origin)),
  );
  if (!origins.length) {
    return;
  }
  await withStoragePage(browser, context, async (page) => {
    for (const origin of origins) {
      const prior = previous.origins.find((o) => o.origin === origin.origin);
      const databases =
        JSON.stringify(origin.indexedDB) === JSON.stringify(prior?.indexedDB)
          ? null
          : (origin.indexedDB ?? []);
      await page.goto(`${origin.origin}/`, { waitUntil: "domcontentloaded", timeout: 5_000 });
      await page.evaluate(restoreOrigin, { origin, databases });
    }
  });
}
