import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { acquireComplaintPage } from "../browser/session.runtime.js";
import { safeErrorFields } from "../complaint-diagnostics.js";
import { runPhoneComplaint } from "../phone/runtime.js";
import { createDouyinDriver } from "../platforms/douyin.js";
import { runReport12377 } from "../platforms/report12377.js";
import { contentIdentity } from "../platforms/targets.js";
import { createWebDriver } from "../platforms/web.js";
import { executeNativeComplaint } from "./native.js";
import type { RunComplaint } from "./types.js";

export const runNativeComplaint: RunComplaint = async (params) => {
  const logger = createSubsystemLogger("complaint/executor");
  const log = (event: Record<string, unknown>) =>
    logger.info(`native ${JSON.stringify({ ...params.diagnosticContext, ...event })}`);
  let lease: Awaited<ReturnType<typeof acquireComplaintPage>>;
  try {
    lease = await acquireComplaintPage({
      handoff: params.browserHandoff,
      allowFakeIp: params.config.allowFakeIp,
    });
  } catch (error) {
    log({ stage: "attach", ...safeErrorFields(error) });
    return {
      state: "manual_required",
      message: "当前对话的浏览器标签页无法接管，请重新查看页面后核对交接。未提交。",
      errorCode: "BROWSER_HANDOFF_REQUIRED",
      offline: null,
    };
  }
  try {
    let item = params.item;
    if (item.report12377) {
      return await runReport12377({
        ...params,
        page: lease.page,
        timeoutMs: params.config.timeoutMs,
        log,
      });
    }
    if (item.platform === "xiaohongshu") {
      const resolveLink = async (value: string) => {
        const url = new URL(value);
        if (
          !contentIdentity("xiaohongshu", value) &&
          !["xhslink.com", "xhslink.cn"].includes(url.hostname)
        ) {
          throw new Error("Not a note link");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.port
        ) {
          throw new Error("Invalid note URL");
        }
        url.protocol = "https:";
        await lease.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (!contentIdentity("xiaohongshu", lease.page.url())) {
          throw new Error("Cannot resolve note identity");
        }
        return lease.page.url();
      };
      item = { ...item, link: await resolveLink(item.link) };
      const body = (await lease.page.locator("body").innerText({ timeout: 5000 })).toLowerCase();
      if (
        [
          "当前内容仅支持在小红书app内查看",
          "请在小红书app内打开",
          "该内容仅支持在app内查看",
          "请打开小红书app查看完整内容",
        ].some((gate) => body.includes(gate))
      ) {
        return await runPhoneComplaint({ ...params, item, resolveLink, log });
      }
    }
    if (item.platform === "douyin" && new URL(item.link).pathname === "/jingxuan") {
      const id = contentIdentity("douyin", item.link);
      if (!id) {
        throw new Error("Cannot resolve video identity");
      }
      item = { ...item, link: `https://www.douyin.com/video/${id}` };
    }
    return await executeNativeComplaint({
      signal: params.signal,
      timeoutMs: params.config.timeoutMs,
      log,
      acquire: async () => {
        const driverParams = {
          page: lease.page,
          item,
          sessionDir: params.sessionDir,
          release: async () => {},
        };
        return item.platform === "douyin"
          ? createDouyinDriver(driverParams)
          : createWebDriver(driverParams);
      },
    });
  } catch (error) {
    log({ stage: "prepare", ...safeErrorFields(error) });
    return {
      state: "failed",
      message: "执行准备中断，未尝试提交。",
      errorCode: "EXECUTION_INTERRUPTED",
      offline: null,
    };
  } finally {
    try {
      await lease.release();
    } catch (error) {
      log({ stage: "release", ...safeErrorFields(error) });
    }
  }
};
