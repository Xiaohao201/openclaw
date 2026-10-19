import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errors, type Page } from "playwright-core";
import type { LocalComplaintItem } from "../complaint-local-contract.js";
import { DOUYIN_REASON_MAX_LENGTH } from "../complaint-platform-policy.js";
import {
  ComplaintNeedsOperator,
  type ComplaintDriver,
  type ComplaintVerification,
} from "../executor/native.js";

const normalize = (value: string) =>
  value.replace(/^\s*\d{1,3}[.、．)）:：]\s*/, "").replace(/[\s\p{P}]/gu, "");
const aliases = [
  ["不实信息", "内容不实", "虚假谣言", "造谣传谣", "传播虚假信息", "网络谣言", "谣言"],
  ["侵犯隐私", "泄露隐私"],
  ["侮辱谩骂", "人身攻击", "不友善言论"],
];
export function selectDouyinCategory(requested: string, options: string[]): string | undefined {
  const key = normalize(requested);
  const exact = options.filter((option) => normalize(option) === key);
  if (exact.length === 1) {
    return exact[0];
  }
  const group = aliases.find((values) => values.some((value) => normalize(value) === key));
  const matches = options.filter((option) =>
    group?.some((value) => normalize(value) === normalize(option)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Page-only adapter: no database, browser startup, batch routing or submission retries. */
export function createDouyinDriver(params: {
  page: Page;
  item: LocalComplaintItem;
  sessionDir: string;
  release: () => Promise<void>;
}): ComplaintDriver {
  const { page, item } = params;
  let selectedLabel: string | undefined;
  const timeout = 10000;
  const checkTarget = () => {
    const expected = new URL(item.link);
    const current = new URL(page.url());
    const id = expected.pathname.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1];
    if (
      !id ||
      !["www.douyin.com", "douyin.com"].includes(current.hostname) ||
      !new RegExp(`^/(?:video|note)/${id}/?$`).test(current.pathname)
    ) {
      throw new ComplaintNeedsOperator(
        "TARGET_UNAVAILABLE",
        "当前页面与授权的视频或图文目标不一致，未提交。",
      );
    }
  };
  const checkCaptcha = async () => {
    if (
      await page
        .getByText(/请完成.*验证|拖动滑块|安全验证/)
        .first()
        .isVisible()
    ) {
      throw new ComplaintNeedsOperator(
        "CAPTCHA_REQUIRED",
        "平台要求人工验证，请在当前浏览器完成验证。",
      );
    }
  };
  const report = () => page.getByText("举报", { exact: true });
  const receipt = () => page.getByText("提交成功", { exact: false }).and(page.locator(":visible"));
  return {
    async navigate() {
      const url = new URL(item.link);
      if (
        url.protocol !== "https:" ||
        !["www.douyin.com", "douyin.com"].includes(url.hostname) ||
        !/^\/(video|note)\/\d+\/?$/.test(url.pathname) ||
        url.username ||
        url.password ||
        url.port
      ) {
        throw new ComplaintNeedsOperator(
          "TARGET_UNAVAILABLE",
          "抖音执行器需要已解析的 HTTPS 视频或图文详情链接。",
        );
      }
      await page.goto(item.link, { waitUntil: "domcontentloaded", timeout: 30000 });
      checkTarget();
      await checkCaptcha();
    },
    async checkLogin() {
      const avatar = page.locator('a[href*="/user/self"] img').first();
      try {
        await avatar.waitFor({ state: "visible", timeout });
      } catch {
        return false;
      }
      return (
        (await avatar.isVisible()) &&
        !(await page.getByText("登录", { exact: true }).first().isVisible())
      );
    },
    async prepare(onStep) {
      checkTarget();
      if (item.reason.length > DOUYIN_REASON_MAX_LENGTH) {
        throw new ComplaintNeedsOperator(
          "REASON_TOO_LONG",
          `抖音举报理由超过${DOUYIN_REASON_MAX_LENGTH}字符，未提交。请压缩已核定理由并重新核对，不能自动截断。`,
        );
      }
      await checkCaptcha();
      onStep?.("wait_report_entry");
      const more = page.locator('[data-e2e="video-play-more"]:visible').first();
      // The avatar may render before the report entry; hidden menu copies are not a fallback.
      await report()
        .and(page.locator(":visible"))
        .or(more)
        .first()
        .waitFor({ state: "visible", timeout });
      if (!(await report().isVisible())) {
        onStep?.("hover_more");
        await more.hover({ timeout });
      }
      onStep?.("open_report");
      await report().click({ timeout });
      onStep?.("wait_report_form");
      await page.getByText("举报原因", { exact: true }).waitFor({ state: "visible", timeout });
      await checkCaptcha();
      onStep?.("select_category");
      const options = await page.locator("span:visible").allTextContents();
      selectedLabel = selectDouyinCategory(
        item.category,
        options.map((option) => option.trim()),
      );
      if (!selectedLabel) {
        throw new ComplaintNeedsOperator(
          "CATEGORY_REQUIRED",
          "举报分类无法唯一匹配页面选项，请提供核定的 categories 分类文字。",
        );
      }
      await page
        .getByText(selectedLabel, { exact: true })
        .locator("xpath=preceding-sibling::div[1]")
        .click({ timeout });
      onStep?.("fill_description");
      let description = page.locator('textarea[placeholder*="描述"]:visible');
      if (!(await description.count())) {
        description = page
          .locator('xpath=//*[contains(text(),"举报描述")]/following::textarea[1]')
          .and(page.locator(":visible"));
      }
      if ((await description.count()) !== 1) {
        throw new ComplaintNeedsOperator(
          "DESCRIPTION_WRITE_FAILED",
          "未找到唯一可见的举报描述输入框，未提交，请人工核对页面。",
        );
      }
      await description.fill(item.reason, { timeout });
      // Controlled inputs can reject fill() without throwing; verify what the page retained.
      await description.blur({ timeout });
      onStep?.("verify_description");
      if ((await description.inputValue({ timeout })) !== item.reason.replace(/\r\n?/g, "\n")) {
        throw new ComplaintNeedsOperator(
          "DESCRIPTION_WRITE_FAILED",
          "页面实际保留的举报描述与核定理由不一致，未提交，请检查字数限制及表单状态。",
        );
      }
      checkTarget();
      await checkCaptcha();
      onStep?.("check_submit");
      if (!(await page.getByText("提交", { exact: true }).isEnabled())) {
        throw new ComplaintNeedsOperator(
          "CATEGORY_REQUIRED",
          "举报表单尚未允许提交，请人工核对必填材料。",
        );
      }
    },
    async submit() {
      checkTarget();
      if (await receipt().first().isVisible()) {
        throw new Error("Receipt existed before submit");
      }
      await page.getByText("提交", { exact: true }).click({ timeout });
    },
    async verify(): Promise<ComplaintVerification> {
      const form = page.locator('[data-e2e="report-container"]:visible');
      // Match validation feedback, not the static optional "请选择具体的类型" heading.
      // Only normalized codes/messages leave the page; never log raw form or complaint text.
      const feedback = [
        {
          locator: form.getByText(/^请(?:填写|输入|补充)(?:举报)?(?:描述|说明|理由|内容)[。！!]?$/),
          validationError: "DESCRIPTION_REQUIRED",
          message: "平台提示举报描述未填写。",
        },
        {
          locator: form.getByText(
            /^(?:举报)?(?:描述|说明|理由|内容)(?:最多|不得超过|不能超过)\s*\d+\s*(?:字|字符)[。！!]?$/,
          ),
          validationError: "DESCRIPTION_TOO_LONG",
          message: "平台提示举报描述超出字数限制。",
        },
        {
          locator: form.getByText(
            /^请(?:选择|勾选)(?:具体的?|二级)?举报(?:类型|分类|原因)[。！!]?$/,
          ),
          validationError: "CATEGORY_REQUIRED",
          message: "平台提示需要补选举报分类。",
        },
        {
          locator: form.locator('[role="alert"], [aria-invalid="true"]'),
          validationError: "OTHER",
          message: "举报表单出现错误提示，请查看截图核对。",
        },
      ] as const;
      const unconfirmed: ComplaintVerification = {
        confirmed: false,
        errorCode: "RECEIPT_UNCONFIRMED",
        message: "已尝试提交但未观察到成功提示，请人工核对，勿自动重提。",
      };
      try {
        await feedback
          .reduce(
            (matches, entry) => matches.or(entry.locator.and(page.locator(":visible"))),
            receipt(),
          )
          .first()
          .waitFor({ state: "visible", timeout });
      } catch (error) {
        if (error instanceof errors.TimeoutError) {
          return unconfirmed;
        }
        throw error;
      }
      if (await receipt().first().isVisible()) {
        return { confirmed: true };
      }
      for (const entry of feedback) {
        if (await entry.locator.and(page.locator(":visible")).first().isVisible()) {
          return {
            confirmed: false,
            errorCode: "FORM_VALIDATION_FAILED",
            validationError: entry.validationError,
            message: `${entry.message}未确认提交成功，禁止自动重提。`,
          };
        }
      }
      return unconfirmed;
    },
    async screenshot() {
      const fileName = `${randomUUID().replaceAll("-", "")}.png`;
      const directory = join(params.sessionDir, "screenshots");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const data = await page.screenshot({ type: "png", timeout });
      if (data.length > 10 * 1024 * 1024) {
        throw new Error("Screenshot too large");
      }
      await writeFile(join(directory, fileName), data, { flag: "wx", mode: 0o600 });
      return { fileName, capturedAt: new Date().toISOString() };
    },
    release: params.release,
  };
}
