import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { runReport12377 } from "./report12377.js";
it.runIf(Boolean(process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME))(
  "observes manual anonymous receipts without sending any live report",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "anonymous-fixture-"));
    const browser = await chromium.launch({
      executablePath: process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME,
      headless: true,
      env: { ...process.env, USERPROFILE: userInfo().homedir, HOME: userInfo().homedir },
    });
    try {
      for (const mode of ["receipt", "missing_receipt", "cancel"] as const) {
        const page = await browser.newPage();
        let posts = 0;
        await page.route("**/*", async (route) => {
          if (route.request().method() === "POST") {
            posts++;
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify(
                mode === "receipt"
                  ? { code: 1000, result: { retrievalCode: "local-fixture-code" } }
                  : { code: 500 },
              ),
            });
            return;
          }
          const path = new URL(route.request().url()).pathname;
          const html = path.endsWith("nmjb.html")
            ? '<div id="big_HAEM">谣言类</div><select id="report_platform"><option value="WEBSITE">网站</option></select><input id="website_name"><input id="website_address"><textarea id="report_content"></textarea><script>window.jQuery=()=>({niceSelect(){}})</script>'
            : '<input id="isee" type="checkbox"><button id="agree">同意</button><a id="nmjb_tabs" href="/jbxzxq/jbxx/nmjb/nmjb.html">匿名</a>';
          await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
        });
        const controller = new AbortController();
        const diagnostics: Record<string, unknown>[] = [];
        const result = await runReport12377({
          page,
          sessionDir: root,
          signal: controller.signal,
          timeoutMs: 500,
          log: (event) => diagnostics.push(event),
          item: {
            platform: "report12377",
            link: "https://example.test/article",
            reason: "offline fixture only",
            role: "Personal",
            category: "rumor",
            report12377: { category: "rumor", websiteName: "fixture" },
          },
          progress: async () => {
            expect(await page.locator("#website_address").inputValue()).toBe(
              "https://example.test/article",
            );
            if (mode === "cancel") {
              controller.abort();
            } else {
              await page.evaluate(async () => {
                await fetch("/rpapi/portal/report/add", {
                  method: "POST",
                  body: "offline-fixture",
                });
              });
            }
          },
        });
        expect(result.state, JSON.stringify(diagnostics)).toBe(
          mode === "receipt" ? "done" : mode === "cancel" ? "manual_required" : "unknown",
        );
        expect(result.queryCode).toBe(mode === "receipt" ? "local-fixture-code" : undefined);
        expect(posts).toBe(mode === "cancel" ? 0 : 1);
        expect(page.isClosed()).toBe(false);
        await page.close();
      }
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
