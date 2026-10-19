import { userInfo } from "node:os";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDouyinDriver } from "./douyin.js";

describe.runIf(Boolean(process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME))(
  "Douyin form validation",
  () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME,
        headless: true,
        env: { ...process.env, USERPROFILE: userInfo().homedir, HOME: userInfo().homedir },
      });
    });
    afterEach(async () => {
      await page?.close();
    });
    afterAll(async () => {
      await browser?.close();
    });

    async function fixture(
      reason: string,
      options: {
        input?: "normal" | "rollback" | "clear" | "truncate" | "missing" | "fallback";
        feedback?:
          | "success"
          | "success-detail"
          | "empty"
          | "length"
          | "category"
          | "other"
          | "none";
      } = {},
    ) {
      page = await browser.newPage();
      const input = options.input ?? "normal";
      const feedback = {
        success: "提交成功",
        "success-detail": "提交成功，感谢您的反馈",
        empty: "请填写举报描述",
        length: "举报描述最多200字",
        category: "请选择具体举报原因",
        other: "fixture private platform response",
        none: "",
      }[options.feedback ?? "success"];
      // Offline HTML mirrors the observed controlled-input rollback. No live requests or reports.
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><meta charset="utf-8">
        <button onclick="document.querySelector('#form').hidden=false">举报</button>
        <section id="form" data-e2e="report-container" hidden><h2>举报原因</h2>
        <div><div style="width:20px;height:20px;background:red" onclick="document.querySelector('#submit').disabled=false"></div><span>不实信息</span></div>
        <p>请选择具体的类型</p>
        ${
          input === "missing"
            ? ""
            : `<label>举报描述</label><textarea ${input === "fallback" ? "" : 'placeholder="举报描述"'} ${input === "truncate" ? 'maxlength="10"' : ""}
          oninput="if(this.value.length>200 || ${input === "rollback" || input === "clear"}){this.value='${input === "clear" ? "" : "previous value"}'}"></textarea>`
        }
        <div id="feedback" ${options.feedback === "other" ? 'role="alert"' : ""} hidden>${feedback}</div>
        <button id="submit" disabled onclick="window.submitted=(window.submitted||0)+1;document.querySelector('#feedback').hidden=false">提交</button></section>`,
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
          reason,
          role: "Personal",
        },
      });
      await driver.navigate();
      return driver;
    }

    it.each([201, 350])(
      "stops a %s-character reason before filling or submitting",
      async (length) => {
        const driver = await fixture("测".repeat(length));
        await expect(driver.prepare()).rejects.toMatchObject({ code: "REASON_TOO_LONG" });
        expect(await page.locator("textarea").inputValue()).toBe("");
        expect(await page.evaluate(() => Reflect.get(window, "submitted"))).toBeUndefined();
      },
    );
    it.each(["rollback", "clear", "truncate", "missing"] as const)(
      "stops when the field is %s",
      async (input) => {
        const driver = await fixture("Offline description with verified evidence", { input });
        await expect(driver.prepare()).rejects.toMatchObject({ code: "DESCRIPTION_WRITE_FAILED" });
        expect(await page.evaluate(() => Reflect.get(window, "submitted"))).toBeUndefined();
      },
    );
    it.each([
      { reason: "测".repeat(200), input: "normal" as const },
      { reason: "Offline evidence\r\nsecond line", input: "fallback" as const },
    ])(
      "preserves an accepted reason including normalized line endings",
      async ({ reason, input }) => {
        const driver = await fixture(reason, { input });
        await driver.prepare();
        expect(await page.locator("textarea").inputValue()).toBe(reason.replaceAll("\r\n", "\n"));
        expect(await page.evaluate(() => Reflect.get(window, "submitted"))).toBeUndefined();
      },
    );
    it.each([
      ["empty", "DESCRIPTION_REQUIRED"],
      ["length", "DESCRIPTION_TOO_LONG"],
      ["category", "CATEGORY_REQUIRED"],
      ["other", "OTHER"],
    ] as const)(
      "detects %s validation feedback after clicking once",
      async (feedback, validationError) => {
        const driver = await fixture("Offline evidence for the fixture only", { feedback });
        await driver.prepare();
        await driver.submit();
        const result = await driver.verify();
        expect(result).toMatchObject({
          confirmed: false,
          errorCode: "FORM_VALIDATION_FAILED",
          validationError,
        });
        expect(JSON.stringify(result)).not.toContain("private");
        expect(await page.evaluate(() => Reflect.get(window, "submitted"))).toBe(1);
      },
      15000,
    );
    it.each(["success", "success-detail"] as const)(
      "confirms a new %s receipt",
      async (feedback) => {
        const driver = await fixture("Offline evidence for the fixture only", { feedback });
        await driver.prepare();
        await driver.submit();
        expect(await driver.verify()).toEqual({ confirmed: true });
      },
    );
    it("keeps a missing receipt unknown without treating a static category hint as an error", async () => {
      const driver = await fixture("Offline evidence for the fixture only", { feedback: "none" });
      await driver.prepare();
      await driver.submit();
      expect(await driver.verify()).toMatchObject({
        confirmed: false,
        errorCode: "RECEIPT_UNCONFIRMED",
      });
    }, 15000);
    it("does not swallow a closed-page error as a receipt timeout", async () => {
      const driver = await fixture("Offline evidence for the fixture only");
      await driver.prepare();
      await page.close();
      await expect(driver.verify()).rejects.toThrow();
    });
  },
);
