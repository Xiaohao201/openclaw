import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { expect, it } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { synchronizeSharedBrowserLogin } from "./complaint-shared-login.runtime.js";

// Opt-in real Chrome integration: isolated profiles and intercepted, offline fixture pages.
it.runIf(Boolean(process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME))(
  "shares the default browser's login across distinct CDP ports without closing tabs",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-login-browser-"));
    const contexts: BrowserContext[] = [];
    const profile = (n: number) => `leading-${String(n).padStart(56, "0")}`;
    const launch = async (name: string) => {
      const directory = join(root, "browser", name, "user-data");
      await mkdir(directory, { recursive: true });
      const context = await chromium.launchPersistentContext(directory, {
        executablePath: process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME,
        headless: true,
        timeout: 10_000,
        // The shared test setup replaces USERPROFILE. Chrome's Windows profile
        // validation requires the OS account directory even with an isolated --user-data-dir.
        env: { ...process.env, USERPROFILE: userInfo().homedir, HOME: userInfo().homedir },
        args: ["--remote-debugging-port=0", "--no-first-run"],
      });
      contexts.push(context);
      await context.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: "<title>Offline login fixture</title>" }),
      );
      const port = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split(
        /\r?\n/,
      )[0];
      const page = context.pages()[0];
      await page.goto("https://weibo.com");
      return { context, page, directory, endpoint: `http://127.0.0.1:${port}/` };
    };
    try {
      const source = await launch("source");
      const first = await launch(profile(1));
      const second = await launch(profile(2));
      const cookie = (value: string) => ({
        name: "session",
        value,
        domain: ".weibo.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax" as const,
      });
      await source.context.addCookies([
        cookie("fixture-default-account"),
        { ...cookie("private"), domain: ".example.org" },
      ]);
      await source.page.evaluate(async () => {
        localStorage.setItem("login", "fixture-default-token");
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("fixture-auth", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("tokens");
          request.addEventListener("error", () => reject(request.error));
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction("tokens", "readwrite");
            transaction.objectStore("tokens").put("fixture-indexed-token", "login");
            transaction
              .objectStore("tokens")
              .put(
                { date: new Date("2026-01-01"), bytes: new Uint8Array([1, 2]), count: 42n },
                "metadata",
              );
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            transaction.addEventListener("error", () => {
              db.close();
              reject(transaction.error);
            });
          };
        });
      });
      const api = {
        runtime: { state: { resolveStateDir: () => root } },
      } as unknown as OpenClawPluginApi;
      const deps = {
        start: async () => {},
        connect: (endpoint: string) => chromium.connectOverCDP(endpoint),
        source: () => ({
          profile: "user",
          key: `source-${"a".repeat(56)}`,
          endpoint: async () => source.endpoint,
        }),
      };
      const identity = (name: string, browser: typeof first) => ({
        profile: name,
        binding: { version: 1, profileDir: browser.directory, cdpUrl: browser.endpoint },
      });
      await first.context.addCookies([cookie("old-user-account")]);
      await second.page.evaluate(() => sessionStorage.setItem("task", "keep-this-task"));
      expect((await source.context.storageState({ indexedDB: true })).origins[0]).toMatchObject({
        indexedDB: [{ name: "fixture-auth" }],
      });
      await synchronizeSharedBrowserLogin(api, identity(profile(1), first), true, deps);
      await synchronizeSharedBrowserLogin(api, identity(profile(2), second), true, deps);
      expect(new Set([source.endpoint, first.endpoint, second.endpoint]).size).toBe(3);
      for (const browser of [first, second]) {
        expect((await browser.context.cookies()).find((c) => c.name === "session")?.value).toBe(
          "fixture-default-account",
        );
        expect((await browser.context.cookies()).some((c) => c.domain === ".example.org")).toBe(
          false,
        );
        expect(await browser.page.evaluate(() => localStorage.getItem("login"))).toBe(
          "fixture-default-token",
        );
        expect(browser.page.isClosed()).toBe(false);
        expect(browser.context.pages()).toHaveLength(1);
        expect((await browser.context.storageState({ indexedDB: true })).origins[0]).toMatchObject({
          indexedDB: [{ name: "fixture-auth" }],
        });
        expect(
          await browser.page.evaluate(
            async () =>
              await new Promise((resolve, reject) => {
                const request = indexedDB.open("fixture-auth", 1);
                request.addEventListener("error", () => reject(request.error));
                request.onsuccess = () => {
                  const db = request.result;
                  const read = db.transaction("tokens").objectStore("tokens").get("login");
                  read.onsuccess = () => {
                    db.close();
                    resolve(read.result);
                  };
                  read.addEventListener("error", () => {
                    db.close();
                    reject(read.error);
                  });
                };
              }),
          ),
        ).toBe("fixture-indexed-token");
      }
      const heldDatabase = await second.page.evaluateHandle(
        async () =>
          await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("fixture-auth", 1);
            request.addEventListener("error", () => reject(request.error));
            request.onsuccess = () => resolve(request.result);
          }),
      );
      const metadata = await heldDatabase.evaluate(
        async (db) =>
          await new Promise<boolean>((resolve, reject) => {
            const request = db.transaction("tokens").objectStore("tokens").get("metadata");
            request.addEventListener("error", () => reject(request.error));
            request.onsuccess = () =>
              resolve(
                request.result.date instanceof Date &&
                  request.result.bytes instanceof Uint8Array &&
                  request.result.bytes[1] === 2 &&
                  request.result.count === 42n,
              );
          }),
      );
      expect(metadata).toBe(true);
      await first.context.addCookies([cookie("fixture-updated")]);
      await synchronizeSharedBrowserLogin(api, identity(profile(1), first), false, deps);
      await synchronizeSharedBrowserLogin(api, identity(profile(2), second), true, deps);
      expect((await source.context.cookies()).find((c) => c.domain === ".weibo.com")?.value).toBe(
        "fixture-updated",
      );
      expect((await second.context.cookies()).find((c) => c.domain === ".weibo.com")?.value).toBe(
        "fixture-updated",
      );
      await first.context.clearCookies({ domain: ".weibo.com" });
      await first.page.evaluate(async () => {
        localStorage.clear();
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("fixture-auth", 1);
          request.addEventListener("error", () => reject(request.error));
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction("tokens", "readwrite");
            transaction.objectStore("tokens").clear();
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            transaction.addEventListener("error", () => {
              db.close();
              reject(transaction.error);
            });
          };
        });
      });
      await synchronizeSharedBrowserLogin(api, identity(profile(1), first), false, deps);
      await synchronizeSharedBrowserLogin(api, identity(profile(2), second), true, deps);
      expect(await second.context.cookies("https://weibo.com")).toEqual([]);
      expect(await second.page.evaluate(() => localStorage.getItem("login"))).toBeNull();
      expect(await second.page.evaluate(() => sessionStorage.getItem("task"))).toBe(
        "keep-this-task",
      );
      expect(
        await heldDatabase.evaluate(
          async (db) =>
            await new Promise<number>((resolve, reject) => {
              const request = db.transaction("tokens").objectStore("tokens").count();
              request.onsuccess = () => resolve(request.result);
              request.addEventListener("error", () => reject(request.error));
            }),
        ),
      ).toBe(0);
      await heldDatabase.evaluate((db) => db.close());
      await heldDatabase.dispose();
      expect((await source.context.cookies("https://example.org"))[0].value).toBe("private");
      expect(source.page.isClosed()).toBe(false);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
