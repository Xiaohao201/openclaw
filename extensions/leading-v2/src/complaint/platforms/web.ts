import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Locator, FrameLocator } from "playwright-core";
import type { LocalComplaintItem } from "../complaint-local-contract.js";
import { ComplaintNeedsOperator, type ComplaintDriver } from "../executor/native.js";
import { selectDouyinCategory } from "./douyin.js";
import { contentIdentity, matchesReportTarget } from "./targets.js";
import { webContract } from "./web-contracts.js";

const timeout = 10000;
const terminal = /^(?:提交|确认|确定|完成|下一步|返回|举报|投诉|继续投诉|取消|关闭|登录|注册)$/;
export async function savePageEvidence(page: Page, sessionDir: string) {
  const bytes = await page.screenshot({ type: "png", timeout });
  if (bytes.length > 10 * 1024 * 1024) {
    throw new Error("Screenshot too large");
  }
  const directory = join(sessionDir, "screenshots");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fileName = randomUUID().replaceAll("-", "") + ".png";
  await writeFile(join(directory, fileName), bytes, { flag: "wx", mode: 0o600 });
  return { fileName, capturedAt: new Date().toISOString() };
}
export async function chooseCategory(options: Locator, requested: string) {
  if (!requested.trim() || terminal.test(requested.trim())) {
    throw new ComplaintNeedsOperator(
      "CATEGORY_REQUIRED",
      "分类必须是具体举报原因，不能是操作按钮。",
    );
  }
  const candidates: { label: string; node: Locator }[] = [];
  for (const node of (await options.all()).slice(0, 150)) {
    if (!(await node.isVisible()) || !(await node.isEnabled())) {
      continue;
    }
    const label = (await node.innerText()).trim();
    if (label && label.length <= 100 && !terminal.test(label)) {
      candidates.push({ label, node });
    }
  }
  const label = selectDouyinCategory(
    requested,
    candidates.map((c) => c.label),
  );
  const choice = candidates.find((candidate) => candidate.label === label);
  if (!choice) {
    throw new ComplaintNeedsOperator(
      "CATEGORY_REQUIRED",
      "页面分类不能唯一匹配已核定原因，请明确 categories，未提交。",
    );
  }
  await choice.node.click({ timeout });
}

export function createWebDriver(params: {
  page: Page;
  item: LocalComplaintItem;
  sessionDir: string;
  release: () => Promise<void>;
}): ComplaintDriver {
  const { page, item } = params;
  const spec = webContract(item.platform, item.link);
  const identity = contentIdentity(item.platform, item.link);
  let reportPage = page;
  let form: Page | FrameLocator = page;
  let reportUrl: string | undefined;
  const verifyEmbeddedTarget = async () => {
    if (item.platform === "futu") {
      const matches = await page.evaluate(`(() => {
        const feed = window.__INITIAL_STATE__?.detail?.feedCommon;
        return String(feed?.feedId ?? '') === ${JSON.stringify(identity)} && feed?.accessPermission?.report === true;
      })()`);
      if (matches !== true) {
        throw new Error("Feed identity or report permission changed");
      }
    }
    if (item.platform === "yidianzixun") {
      const matches = await page.evaluate(`(() => {
        const info = window.yidian?.docinfo;
        return info?.doc?.docid === ${JSON.stringify(identity)} && info?.is_login === true;
      })()`);
      if (matches !== true) {
        throw new Error("Article identity or login changed");
      }
    }
  };
  const field = (selector: string) =>
    selector.startsWith("text=")
      ? form.getByText(selector.slice(5), { exact: true })
      : form.locator(selector);
  const guard = async () => {
    if (
      await reportPage
        .getByText(/请完成.*验证|拖动滑块|请输入图中字符|安全验证/)
        .first()
        .isVisible()
    ) {
      throw new ComplaintNeedsOperator("CAPTCHA_REQUIRED", "需要本人完成平台验证码，未提交。");
    }
    if (
      await reportPage
        .getByText(/请先登录|登录后举报|请登录后操作|实名信息|上传.*身份证/)
        .first()
        .isVisible()
    ) {
      throw new ComplaintNeedsOperator(
        "MATERIAL_REQUIRED",
        "需要登录或身份材料，请本人处理，未提交。",
      );
    }
  };
  const verifyTarget = () => {
    if (!identity) {
      throw new ComplaintNeedsOperator("TARGET_UNAVAILABLE", "不是支持的内容详情链接，未提交。");
    }
    if (["sina", "sohu", "tiantianfund"].includes(item.platform) && reportUrl) {
      if (!matchesReportTarget(item.platform, reportPage.url(), item.link)) {
        throw new Error("Report target mismatch");
      }
    } else if (
      (reportUrl && reportPage !== page) ||
      (reportUrl && ["netease", "eastmoney", "weibo"].includes(item.platform))
    ) {
      if (reportPage.url() !== reportUrl) {
        throw new Error("Report page changed");
      }
    } else if (contentIdentity(item.platform, page.url()) !== identity) {
      throw new Error("Content target changed");
    }
  };
  return {
    async navigate() {
      if (!identity) {
        throw new ComplaintNeedsOperator(
          "TARGET_UNAVAILABLE",
          "需要已解析的内容详情链接，未提交。",
        );
      }
      await page.goto(item.link, { waitUntil: "domcontentloaded", timeout: 30000 });
      verifyTarget();
      if (
        await page
          .getByText(/内容不存在|内容已删除|该内容已被删除/)
          .first()
          .isVisible()
      ) {
        throw new ComplaintNeedsOperator("TARGET_UNAVAILABLE", "目标内容已不可用，未提交。");
      }
      await guard();
    },
    async checkLogin() {
      if (item.platform === "netease") {
        return page.locator("#js_N_navLoginAfter").first().isVisible();
      }
      if (item.platform === "tencent") {
        return (
          (await page.locator("#qqcom-login.qqcon-islogin").isVisible()) &&
          !(await page.locator("#qqcom-login .login-button").isVisible())
        );
      }
      if (item.platform === "yidianzixun") {
        return page.evaluate(
          "Boolean(window.yidian && window.yidian.docinfo && window.yidian.docinfo.is_login === true)",
        );
      }
      if (item.platform === "futu") {
        // Browser fetch retains the session and the browser request guard.
        return page.evaluate(async () => {
          const response = await fetch("/v2/api/sns/get-content-report-type-list", {
            signal: AbortSignal.timeout(10000),
          });
          const result: unknown = await response.json();
          return (
            response.ok &&
            typeof result === "object" &&
            result !== null &&
            "code" in result &&
            result.code === 0
          );
        });
      }
      // Other platform forms enforce their own login gates; do not treat a hidden
      // login template as a failure. Readiness is checked again before submission.
      return !(await page
        .getByText(/^(?:登录\/注册|立即登录|请先登录)$/)
        .first()
        .isVisible());
    },
    async prepare() {
      verifyTarget();
      await verifyEmbeddedTarget();
      if (["sohu", "netease"].includes(item.platform) && /侵权|抄袭/.test(item.category)) {
        throw new ComplaintNeedsOperator(
          "MATERIAL_REQUIRED",
          "该分类需要本人提供身份和权属材料，未提交。",
        );
      }
      if (item.platform === "sina") {
        if (new URL(item.link).hostname === "super.sina.cn") {
          const scripts = await page.locator("script:not([src])").allTextContents();
          for (const source of scripts) {
            for (const match of source.matchAll(
              /"feedback"\s*:\s*\{\s*"link"\s*:\s*("(?:\\.|[^"\\])*")/g,
            )) {
              const value: unknown = JSON.parse(match[1]);
              if (typeof value === "string" && matchesReportTarget("sina", value, item.link)) {
                reportUrl = value;
              }
            }
          }
          if (!reportUrl) {
            throw new Error("Missing bound feedback URL");
          }
        } else {
          reportUrl = `https://news.sina.com.cn/blank/report_news.shtml?docId=${encodeURIComponent(identity!)}`;
        }
        await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (
          new URL(item.link).hostname !== "super.sina.cn" &&
          !(await page.evaluate(
            "Boolean(window.SINA_OUTLOGIN_LAYER && window.SINA_OUTLOGIN_LAYER.isLogin())",
          ))
        ) {
          throw new ComplaintNeedsOperator(
            "MATERIAL_REQUIRED",
            "请在新浪举报页完成本人登录，未提交。",
          );
        }
      } else {
        if (spec.menu) {
          const menu = page.locator(spec.menu).first();
          if (spec.hover) {
            await menu.hover({ timeout });
          } else {
            await menu.click({ timeout });
          }
        }
        const entry = spec.entry.startsWith("text=")
          ? page.getByText(spec.entry.slice(5), { exact: true })
          : page.locator(spec.entry);
        if (spec.popup) {
          const href = await entry.first().getAttribute("href");
          if (href) {
            const url = new URL(href, page.url());
            const allowed =
              item.platform === "netease"
                ? url.hostname === "www.163.com" && url.pathname === "/special/0077jt/tipoff.html"
                : item.platform === "eastmoney"
                  ? url.hostname === "help.eastmoney.com" && url.pathname === "/report_center.html"
                  : ["sohu", "tiantianfund"].includes(item.platform)
                    ? matchesReportTarget(item.platform, url.href, item.link)
                    : url.hostname === "service.account.weibo.com";
            if (!allowed || url.protocol !== "https:" || url.username || url.password) {
              throw new Error("Unexpected report URL");
            }
            // Navigate the same borrowed tab to a validated entry URL. No extra browser.
            await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
          } else {
            const [popup] = await Promise.all([
              page.waitForEvent("popup", { timeout }),
              entry.click({ timeout }),
            ]);
            reportPage = popup;
            await reportPage.waitForURL((url) => url.protocol === "https:", { timeout });
            await reportPage.waitForLoadState("domcontentloaded", { timeout });
            const opened = new URL(reportPage.url());
            if (
              item.platform !== "weibo" ||
              !["service.account.weibo.com", "service.account.weibo.cn"].includes(opened.hostname)
            ) {
              throw new Error("Unexpected popup");
            }
          }
          reportUrl = reportPage.url();
          form = reportPage;
        } else {
          await entry.click({ timeout });
        }
      }
      if (spec.frame) {
        form = page.frameLocator(spec.frame);
      }
      verifyTarget();
      await guard();
      await field(spec.options).first().waitFor({ state: "visible", timeout });
      await chooseCategory(field(spec.options), item.category);
      if (item.subCategory) {
        await chooseCategory(field(spec.options), item.subCategory);
      }
      if (spec.next && (await field(spec.next).isVisible())) {
        await field(spec.next).click({ timeout });
      }
      if (spec.description && (await field(spec.description).isVisible())) {
        if (spec.descriptionLimit && item.reason.length > spec.descriptionLimit) {
          throw new ComplaintNeedsOperator(
            "MATERIAL_REQUIRED",
            `举报说明超过平台 ${spec.descriptionLimit} 字限制，请缩短后核定，未提交。`,
          );
        }
        await field(spec.description).fill(item.reason, { timeout });
      }
      if (item.platform === "weibo") {
        const next = reportPage.getByText("继续投诉", { exact: true });
        if (await next.isVisible()) {
          await next.click({ timeout });
        }
        await reportPage.locator("input[name='chk']").check({ timeout });
      }
      await guard();
      verifyTarget();
      if (spec.selected && !(await field(spec.selected).first().count())) {
        throw new Error("Category selection not confirmed");
      }
      if (
        !(await field(spec.submit).isEnabled()) ||
        (await field(spec.success).first().isVisible())
      ) {
        throw new Error("Form not ready or stale receipt");
      }
    },
    async submit() {
      verifyTarget();
      await verifyEmbeddedTarget();
      await guard();
      await field(spec.submit).click({ timeout });
    },
    async verify() {
      try {
        await field(spec.success).first().waitFor({ state: "visible", timeout });
        return true;
      } catch {
        return false;
      }
    },
    screenshot: () => savePageEvidence(reportPage, params.sessionDir),
    async release() {
      try {
        if (reportPage !== page) {
          await reportPage.close();
        }
      } finally {
        await params.release();
      }
    },
  };
}
