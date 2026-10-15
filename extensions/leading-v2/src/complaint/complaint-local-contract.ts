import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OpenClawConfig } from "../../api.js";
import { isUnavailableComplaintLink } from "./complaint-platform-policy.js";

// Plugin-owned routing, shared with Python through the validated input payload.
export const localPlatforms: Record<string, readonly string[]> = {
  baidu: ["baidu.com", "baijiahao.baidu.com"],
  bilibili: ["bilibili.com"],
  douyin: ["douyin.com"],
  eastmoney: ["eastmoney.com"],
  futu: ["futunn.com"],
  kuaishou: ["kuaishou.com"],
  netease: ["163.com"],
  sina: ["sina.com.cn", "sina.cn"],
  sohu: ["sohu.com"],
  tencent: ["qq.com"],
  tiantianfund: ["fund.eastmoney.com"],
  toutiao: ["toutiao.com"],
  weibo: ["weibo.com", "weibo.cn"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
  yidianzixun: ["yidianzixun.com"],
  zhihu: ["zhihu.com"],
};

export function platformForLink(link: string): string | null {
  // Do not let excluded WeChat hosts fall through to the broader qq.com route.
  if (isUnavailableComplaintLink(link)) {
    return null;
  }
  try {
    const url = new URL(link);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
      return null;
    }
    // Prefer the most specific suffix (fund.eastmoney.com before eastmoney.com).
    return (
      Object.entries(localPlatforms)
        .flatMap(([platform, domains]) => domains.map((domain) => ({ platform, domain })))
        .toSorted(
          (a, b) => b.domain.length - a.domain.length || a.platform.localeCompare(b.platform),
        )
        .find(({ domain }) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
        ?.platform ?? null
    );
  } catch {
    return null;
  }
}

const reasonSchema = z.string().trim().min(20).max(6000);
const requestSchema = z
  .object({
    basisSource: z.literal("AgentJudgment"),
    confirmed: z.literal(true),
    subjectScope: z.enum(["Institution", "Enterprise"]),
    judgment: reasonSchema,
    links: z.array(z.string().trim().min(1).max(2048)).min(1).max(1000),
    role: z.enum(["Personal", "Enterprise"]).default("Personal"),
    linkJudgments: z
      .array(z.object({ link: z.string(), judgment: reasonSchema }).strict())
      .optional(),
    categories: z
      .array(
        z
          .object({
            link: z.string(),
            category: z.string().trim().min(1).max(200),
            subCategory: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .optional(),
    report12377: z
      .object({
        category: z.enum([
          "politics",
          "terrorism",
          "fraud",
          "pornography",
          "vulgarity",
          "gambling",
          "rumor",
        ]),
        websiteName: z.string().trim().min(1).max(40),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LocalComplaintItem = {
  link: string;
  platform: string;
  reason: string;
  category: string;
  subCategory?: string;
  role: "Personal" | "Enterprise";
  report12377?: { category: string; websiteName: string };
};

export function parseLocalRequest(input: unknown): LocalComplaintItem[] {
  const value = requestSchema.parse(input);
  const links = new Set(value.links);
  if (links.size !== value.links.length) {
    throw new Error("链接不能重复。");
  }
  const judgments = new Map(value.linkJudgments?.map((item) => [item.link, item.judgment]));
  if (
    (value.links.length > 1 || value.linkJudgments !== undefined) &&
    (judgments.size !== links.size ||
      value.linkJudgments?.length !== links.size ||
      [...judgments.keys()].some((link) => !links.has(link)))
  ) {
    throw new Error("每条链接必须提供一份独立的 linkJudgments，不能共用批次摘要。");
  }
  const categories = new Map(value.categories?.map((item) => [item.link, item]));
  if (
    categories.size !== (value.categories?.length ?? 0) ||
    [...categories.keys()].some((link) => !links.has(link))
  ) {
    throw new Error("categories 存在重复或批次外链接。");
  }
  return value.links.map((link) => {
    const url = new URL(link);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("链接必须是无凭证的 HTTP(S) 网址。");
    }
    const platform = value.report12377 ? "report12377" : platformForLink(link);
    if (!platform) {
      throw new Error("包含本地执行器不支持的链接，请查询 complaint_taxonomy。");
    }
    const reason = judgments.get(link) ?? value.judgment;
    if (value.report12377 && (reason.length > 500 || link.length > 500)) {
      throw new Error("12377匿名举报的网址及每条理由均不得超过500字符。");
    }
    const category = categories.get(link);
    return {
      link,
      platform,
      reason,
      category: category?.category ?? reason,
      subCategory: category?.subCategory,
      role: value.role,
      report12377: value.report12377,
    };
  });
}

export const localOutcomeSchema = z
  .object({
    state: z.enum([
      "pending",
      "running",
      "done",
      "failed",
      "manual_required",
      "unknown",
      "not_submitted",
    ]),
    message: z.string().max(2000),
    offline: z.boolean().nullable(),
    errorCode: z.string().max(100).optional(),
    queryCode: z.string().max(128).optional(),
  })
  .strict();
export type LocalOutcome = z.infer<typeof localOutcomeSchema>;

const configSchema = z
  .object({
    mode: z.enum(["local", "backend"]).default("local"),
    python: z.string().min(1).default("python"),
    runtimeDir: z
      .string()
      .min(1)
      .refine(isAbsolute, "runtimeDir must be absolute")
      .default(fileURLToPath(new URL("../../python/", import.meta.url))),
    timeoutMs: z.number().int().min(1000).max(1800000).default(900000),
    headless: z.boolean().default(false),
    phone: z
      .object({
        adbPath: z.string().min(1).default("adb"),
        serial: z.string().min(1).max(200),
        userId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();
export function resolveLocalConfig(
  config: Record<string, unknown>,
  rootDir?: string,
  hostConfig?: Pick<OpenClawConfig, "browser">,
) {
  const parsed = configSchema.parse(config.complaintExecution ?? {});
  const block = config.complaintExecution as Record<string, unknown> | undefined;
  if (rootDir && block?.runtimeDir === undefined) {
    parsed.runtimeDir = join(rootDir, "python");
  }
  return {
    ...parsed,
    allowFakeIp: hostConfig?.browser?.ssrfPolicy?.allowRfc2544BenchmarkRange === true,
  };
}
export type LocalConfig = ReturnType<typeof resolveLocalConfig>;
