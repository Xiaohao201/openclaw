import { setTimeout as sleep } from "node:timers/promises";
import type { Page, Request, Response, Dialog } from "playwright-core";
import { z } from "zod";
import { safeErrorFields } from "../complaint-diagnostics.js";
import type { LocalComplaintItem, LocalOutcome } from "../complaint-local-contract.js";
import { savePageEvidence } from "./web.js";

const categories: Record<string, readonly [string, string]> = {
  politics: ["zzl", "政治类"],
  terrorism: ["bkl", "暴恐类"],
  fraud: ["zpl", "诈骗类"],
  pornography: ["sql", "色情类"],
  vulgarity: ["dsl", "低俗类"],
  gambling: ["dbl", "赌博类"],
  rumor: ["yyl", "谣言类"],
};
const anonymousPath = "/jbxzxq/jbxx/nmjb/nmjb.html";
function official(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["www.12377.cn", "new.12377.cn"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export function officialSubmission(url: string, method: string) {
  return method === "POST" && official(url) && new URL(url).pathname === "/rpapi/portal/report/add";
}
const receipt = z.object({
  code: z.union([z.literal(1000), z.literal("1000")]),
  result: z.object({
    retrievalCode: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (value) => !/\s/.test(value) && value.split("").every((char) => char.charCodeAt(0) >= 32),
      ),
  }),
});
export function receiptCode(payload: unknown): string | undefined {
  const parsed = receipt.safeParse(payload);
  return parsed.success ? parsed.data.result.retrievalCode : undefined;
}

/** The operator solves CAPTCHA and presses submit; only observed receipts confirm success. */
export async function runReport12377(params: {
  page: Page;
  item: LocalComplaintItem;
  sessionDir: string;
  signal: AbortSignal;
  timeoutMs: number;
  progress?: (message: string) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}): Promise<LocalOutcome> {
  const { page, item } = params;
  let attempted = false;
  let stage: "validate" | "notice" | "anonymous" | "fill" | "manual_wait" = "validate";
  let responseError = false;
  let code: string | undefined;
  const requests = new Set<Request>();
  const pending = new Set<Promise<void>>();
  const onRequest = (request: Request) => {
    if (!officialSubmission(request.url(), request.method())) {
      return;
    }
    attempted = true;
    if (official(page.url()) && new URL(page.url()).pathname === anonymousPath) {
      requests.add(request);
    } else {
      responseError = true;
    }
  };
  const onResponse = (response: Response) => {
    if (!requests.has(response.request())) {
      return;
    }
    const task = (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const payload: unknown = response.ok()
          ? await Promise.race([
              response.body().then((bytes) => {
                if (bytes.length > 65536) {
                  throw new Error("Receipt too large");
                }
                return JSON.parse(bytes.toString("utf8")) as unknown;
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Receipt body timed out")), 10000);
              }),
            ]).finally(() => clearTimeout(timer))
          : null;
        const received = receiptCode(payload);
        if (received) {
          code = received;
        }
        if (!received) {
          responseError = true;
        }
      } catch {
        responseError = true;
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const dialog = (_dialog: Dialog) => {
    /* The on-site operator handles native dialogs. */
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("dialog", dialog);
  const outcome = async (): Promise<LocalOutcome> => {
    if (code) {
      const result: LocalOutcome = {
        state: "done",
        message: "官网已返回举报查询码，不代表已受理或处置。",
        queryCode: code,
        offline: null,
      };
      try {
        result.screenshot = await savePageEvidence(page, params.sessionDir);
      } catch {
        result.evidenceError = "SCREENSHOT_CAPTURE_FAILED";
      }
      return result;
    }
    return {
      state: attempted ? "unknown" : "manual_required",
      message: attempted
        ? "已观察到提交但没有可验证查询码，请核查，禁止自动重投。"
        : "人工处理窗口已结束，未观察到提交请求；请核对官网页面。",
      errorCode: attempted ? "RECEIPT_UNCONFIRMED" : "MANUAL_WINDOW_ENDED",
      offline: null,
    };
  };
  const checkpoint = () => {
    if (params.signal.aborted) {
      throw new Error("Cancelled");
    }
  };
  try {
    const setting = item.report12377;
    const category =
      setting && Object.hasOwn(categories, setting.category)
        ? categories[setting.category]
        : undefined;
    if (
      !setting ||
      !category ||
      !item.link ||
      item.link.length > 500 ||
      !item.reason.trim() ||
      item.reason.length > 500 ||
      !setting.websiteName.trim() ||
      setting.websiteName.length > 40
    ) {
      throw new Error("Invalid anonymous report");
    }
    checkpoint();
    stage = "notice";
    await page.goto(`https://www.12377.cn/jbxzxq/${category[0]}jbxzxq.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!official(page.url())) {
      throw new Error("Unofficial report page");
    }
    await page.locator("#isee").check({ timeout: 15000 });
    await page.locator("#agree:not(.grey)").click({ timeout: 15000 });
    stage = "anonymous";
    await page.locator("#nmjb_tabs").click({ timeout: 15000 });
    await page.waitForURL(`**${anonymousPath}`, { timeout: 30000 });
    checkpoint();
    if (
      !official(page.url()) ||
      !(await page.locator("#big_HAEM").innerText()).includes(category[1])
    ) {
      throw new Error("Wrong anonymous category");
    }
    stage = "fill";
    await page.locator("#report_platform").selectOption("WEBSITE", { force: true });
    // The official widget hides the select but listens to its change event.
    await page.locator("#report_platform").evaluate("el => window.jQuery(el).niceSelect('update')");
    await page.locator("#website_name").fill(setting.websiteName);
    await page.locator("#website_address").fill(item.link);
    await page.locator("#report_content").fill(item.reason);
    stage = "manual_wait";
    await params.progress?.(
      "12377匿名表单已填好，请本人在当前标签页核对小类、添加附件、完成验证码并点击提交。正在等待官网查询码。",
    );
    const deadline = Date.now() + Math.min(params.timeoutMs, 600000);
    while (Date.now() < deadline && !params.signal.aborted && !page.isClosed()) {
      if (code || responseError) {
        break;
      }
      await sleep(250);
    }
    await Promise.all(pending);
    return await outcome();
  } catch (error) {
    params.log?.({ stage, attempted, ...safeErrorFields(error) });
    if (attempted || code) {
      return await outcome();
    }
    return {
      state: "failed",
      message: "12377匿名表单准备中断，未观察到提交；请核查页面。",
      errorCode: "FORM_PREPARATION_FAILED",
      offline: null,
    };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("dialog", dialog);
  }
}
