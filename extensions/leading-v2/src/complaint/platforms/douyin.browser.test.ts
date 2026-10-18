import { userInfo } from "node:os";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { createDouyinDriver } from "./douyin.js";

it
  .runIf(Boolean(process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME))
  .each(["delayed-report", "visible-menu"])(
  "prepares %s without getting stuck on a hidden menu",
  async (scenario) => {
    const browser = await chromium.launch({
      executablePath: process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME,
      headless: true,
      env: { ...process.env, USERPROFILE: userInfo().homedir, HOME: userInfo().homedir },
    });
    try {
      const page = await browser.newPage();
      // Every request is fulfilled locally. Neither case submits a real report.
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><meta charset="utf-8">
        <div hidden><div data-e2e="video-play-more">Hidden menu</div></div>
        ${scenario === "visible-menu" ? '<div data-e2e="video-play-more" onmouseover="document.querySelector(\'#report\').hidden=false">More</div>' : ""}
        <button id="report" hidden onclick="document.querySelector('#form').hidden=false">举报</button>
        ${scenario === "delayed-report" ? '<script>setTimeout(()=>document.querySelector("#report").hidden=false,300)</script>' : ""}
        <section id="form" hidden><h2>举报原因</h2>
        <div><div style="width:20px;height:20px;background:red" onclick="document.querySelector('#submit').disabled=false"></div><span>不实信息</span></div>
        <textarea placeholder="举报描述"></textarea>
        <button id="submit" disabled onclick="window.submitted=true">提交</button></section>`,
        }),
      );
      const driver = createDouyinDriver({
        page,
        sessionDir: "unused-fixture",
        release: async () => {},
        item: {
          link: "https://www.douyin.com/video/123456789",
          platform: "douyin",
          category: "不实信息",
          reason: "Offline fixture only",
          role: "Personal",
        },
      });
      await driver.navigate();
      await driver.prepare();
      expect(await page.locator("#form").isVisible()).toBe(true);
      expect(await page.locator("textarea").inputValue()).toBe("Offline fixture only");
      expect(await page.evaluate(() => Boolean(Reflect.get(window, "submitted")))).toBe(false);
    } finally {
      await browser.close();
    }
  },
  15000,
);
