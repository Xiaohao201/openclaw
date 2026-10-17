import type { BrowserHandoff } from "../complaint-session-handoff.js";
import type { LoginConnection } from "./login-session.js";
import { acquireComplaintPage } from "./session.runtime.js";

export const loginUrls: Readonly<Record<string, string>> = {
  baidu: "https://www.baidu.com",
  bilibili: "https://www.bilibili.com",
  douyin: "https://www.douyin.com",
  eastmoney: "https://help.eastmoney.com",
  futu: "https://www.futunn.com",
  kuaishou: "https://www.kuaishou.com",
  netease: "https://www.163.com",
  sina: "https://www.sina.com.cn",
  sohu: "https://www.sohu.com",
  tencent: "https://www.qq.com",
  tiantianfund: "https://fund.eastmoney.com",
  toutiao: "https://www.toutiao.com",
  weibo: "https://weibo.com",
  xiaohongshu: "https://www.xiaohongshu.com",
  yidianzixun: "https://www.yidianzixun.com",
  zhihu: "https://www.zhihu.com",
};

/** Login only: never imports platform adapters or report submission functions. */
export async function openComplaintLogin(params: {
  platform: string;
  handoff: BrowserHandoff;
  allowFakeIp: boolean;
}): Promise<LoginConnection> {
  const url = Object.hasOwn(loginUrls, params.platform) ? loginUrls[params.platform] : undefined;
  if (!url) {
    throw new Error("Unsupported login platform");
  }
  const lease = await acquireComplaintPage(params);
  try {
    await lease.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    for (const label of ["立即登录", "登录/注册", "登录"]) {
      const candidates = await lease.page.getByText(label, { exact: true }).all();
      let opened = false;
      for (const candidate of candidates) {
        if (await candidate.isVisible()) {
          await candidate.click({ timeout: 5000 });
          opened = true;
          break;
        }
      }
      if (opened) {
        break;
      }
    }
    return {
      targetId: params.handoff.targetId,
      screenshot: async () => {
        const image = await lease.page.screenshot({ type: "jpeg", quality: 65, timeout: 10000 });
        if (image.length > 3000000) {
          throw new Error("Login screenshot too large");
        }
        return image.toString("base64");
      },
      release: lease.release,
    };
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
}
