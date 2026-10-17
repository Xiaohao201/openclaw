import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { OpenClawPluginApi } from "../../../api.js";
import { ComplaintBatchStore } from "../complaint-batch-store.js";
import { resolveLocalConfig } from "../complaint-local-contract.js";
import { contentIdentity } from "../platforms/targets.js";
import { runPhoneComplaint } from "./runtime.js";
export async function phonePreflight(
  api: OpenClawPluginApi,
  options: { userId: string; url: string; category: string },
) {
  const config = resolveLocalConfig(api.pluginConfig ?? {}, api.rootDir, api.config);
  if (
    config.mode !== "local" ||
    config.phone?.userId !== options.userId ||
    !contentIdentity("xiaohongshu", options.url)
  ) {
    throw new Error("Preflight requires the configured user and a canonical note URL");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    return await runPhoneComplaint({
      config,
      signal: controller.signal,
      preflight: true,
      sessionDir: new ComplaintBatchStore(() =>
        api.runtime.state.resolveStateDir(),
      ).sessionDirectory(options.userId),
      item: {
        platform: "xiaohongshu",
        link: options.url,
        category: options.category,
        reason: "本地流程适配测试：仅验证中文输入和举报页面交互，不提交举报。",
        role: "Personal",
      },
      resolveLink: async (value) => {
        const url = new URL(value);
        if (contentIdentity("xiaohongshu", value)) {
          return value;
        }
        if (
          !["xhslink.com", "xhslink.cn"].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.port ||
          !["http:", "https:"].includes(url.protocol)
        ) {
          throw new Error("Invalid copied share link");
        }
        url.protocol = "https:";
        const response = await fetchWithSsrFGuard({
          url: url.href,
          maxRedirects: 5,
          timeoutMs: 10000,
          signal: controller.signal,
          capture: false,
          policy: {
            hostnameAllowlist: [
              "xhslink.com",
              "xhslink.cn",
              "*.xiaohongshu.com",
              "xiaohongshu.com",
            ],
            allowRfc2544BenchmarkRange: config.allowFakeIp,
          },
        });
        try {
          if (!contentIdentity("xiaohongshu", response.finalUrl)) {
            throw new Error("Share link did not resolve to a note");
          }
          return response.finalUrl;
        } finally {
          await response.response.body?.cancel();
          await response.release();
        }
      },
    });
  } finally {
    process.off("SIGINT", cancel);
  }
}
