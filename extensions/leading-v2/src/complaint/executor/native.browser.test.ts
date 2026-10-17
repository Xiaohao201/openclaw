import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { LoginSession } from "../browser/login-session.js";
import { openComplaintLogin } from "../browser/login.runtime.js";
import { acquireComplaintPage } from "../browser/session.runtime.js";
import { createDouyinDriver } from "../platforms/douyin.js";
import { executeNativeComplaint } from "./native.js";

// Network is fulfilled locally by the owning connection; no platform request is sent.
vi.mock("openclaw/plugin-sdk/browser-security-runtime", () => ({
  resolvePinnedHostnameWithPolicy: vi.fn().mockResolvedValue({}),
}));
it.runIf(Boolean(process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME))(
  "executes on the exact borrowed tab and leaves the browser alive",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "native-complaint-"));
    const profileDir = join(root, "profile");
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME,
      headless: true,
      env: { ...process.env, USERPROFILE: userInfo().homedir, HOME: userInfo().homedir },
      args: ["--remote-debugging-port=0"],
    });
    try {
      const html = `
      <a href="/user/self"><img width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a>
      <button onclick="document.querySelector('#form').hidden=false">举报</button>
      <section id="form" hidden><h2>举报原因</h2><div><div style="width:20px;height:20px;background:red" onclick="document.querySelector('#submit').disabled=false"></div><span>内容不实</span></div>
      <textarea placeholder="举报描述"></textarea><button id="submit" disabled onclick="window.submissions=(window.submissions||0)+1;document.querySelector('#receipt').hidden=false">提交</button></section>
      <div id="receipt" hidden>提交成功</div>`;
      await context.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
      );
      const page = context.pages()[0];
      const link = "https://www.douyin.com/video/123456789";
      await page.goto(link);
      const marker = randomUUID();
      await page.evaluate(
        (value) => Reflect.set(window, "__openclaw_session_handoff_v1", value),
        marker,
      );
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      await cdp.detach();
      const port = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).split(
        /\r?\n/,
      )[0];
      const handoff = {
        version: 1 as const,
        marker,
        targetId: targetInfo.targetId,
        binding: { version: 1, profileDir, cdpUrl: `http://127.0.0.1:${port}` },
      };
      const errors: string[] = [];
      const outcome = await executeNativeComplaint({
        signal: new AbortController().signal,
        timeoutMs: 30000,
        log: vi.fn(),
        acquire: async () => {
          const lease = await acquireComplaintPage({ handoff, allowFakeIp: false });
          await expect(acquireComplaintPage({ handoff, allowFakeIp: false })).rejects.toThrow();
          await lease.page.route("**/*", (route) =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
          );
          const driver = createDouyinDriver({
            ...lease,
            sessionDir: root,
            item: {
              link,
              platform: "douyin",
              category: "不实信息",
              reason: "Offline fixture only",
              role: "Personal",
            },
          });
          const prepare = driver.prepare;
          driver.prepare = async () => {
            try {
              await prepare();
            } catch (error) {
              errors.push(String(error));
              throw error;
            }
          };
          return driver;
        },
      });
      expect(outcome, JSON.stringify({ outcome, errors })).toMatchObject({ state: "done" });
      expect(await page.evaluate(() => Reflect.get(window, "submissions"))).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, "__openclaw_session_handoff_v1"))).toBe(
        marker,
      );
      expect(context.pages()).toHaveLength(1);
      expect(
        (await readFile(join(root, "screenshots", outcome.screenshot!.fileName)))
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      const login = new LoginSession({
        platform: "douyin",
        sessionKey: "offline-fixture",
        sessionId: "offline-fixture",
        connect: () => openComplaintLogin({ platform: "douyin", handoff, allowFakeIp: false }),
      });
      try {
        expect(await login.start()).toMatchObject({ state: "awaiting_login" });
        expect((await login.command("screenshot")).screenshot).toBeTruthy();
        expect(await login.command("finish")).toMatchObject({ state: "saved" });
        expect(context.pages()).toHaveLength(1);
        expect(page.isClosed()).toBe(false);
        expect(
          await page.evaluate(() => Reflect.get(window, "__openclaw_session_handoff_v1")),
        ).toBe(marker);
        const next = await acquireComplaintPage({ handoff, allowFakeIp: false });
        await next.release();
      } finally {
        await login.stop();
      }
    } finally {
      await context.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
