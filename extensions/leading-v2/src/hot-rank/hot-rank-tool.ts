import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";

const HOT_RANK_API_URL = "http://123.57.81.67:8004/api/v1/hot_rank";
const HOT_RANK_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const PLATFORMS = [
  "douyin",
  "weibo",
  "toutiao",
  "kuaishou",
  "bilibili",
  "baidu",
  "zhihu",
  "xiaohongshu",
  "dongchedi",
  "weixin",
  "wangyi",
  "baidutieba",
  "weibo_uplist",
  "360",
  "uc",
  "qq",
  "sougou",
  "kuake",
] as const;

const HotRankSchema = Type.Object(
  {
    date: Type.Optional(
      Type.String({
        description:
          "日期或日期范围。支持 YYYY-MM-DD，或 YYYY-MM-DD HH:mm,YYYY-MM-DD HH:mm；默认查询北京时间当天。",
      }),
    ),
    keyword: Type.Optional(Type.String({ description: "按热榜标题关键词筛选。" })),
    city: Type.Optional(Type.String({ description: "城市筛选，主要用于同城热榜。" })),
    platform: Type.Optional(
      Type.Unsafe<(typeof PLATFORMS)[number]>({
        type: "string",
        enum: [...PLATFORMS],
        description: "平台英文标识；不传则查询该榜单类型下的所有平台。",
      }),
    ),
    rankType: Type.Optional(
      Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
        description: "榜单类型：1=综合热榜（默认），2=浏览器榜，3=同城热榜。",
      }),
    ),
    limit: Type.Optional(Type.Number({ description: "最多返回多少条，默认20，范围1至100。" })),
  },
  { additionalProperties: false },
);

export type HotRankRequest = {
  date: string;
  keyword: string;
  city: string;
  platform: string;
  rank_type: 1 | 2 | 3;
};

export type HotRankFetcher = (request: HotRankRequest) => Promise<unknown>;

function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match || !validDate(match[1])) {
    return false;
  }
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function resolveDateRange(value: unknown, now: Date): string | null {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) {
    const date = shanghaiDate(now);
    return `${date} 00:00,${date} 23:59`;
  }
  if (validDate(input)) {
    return `${input} 00:00,${input} 23:59`;
  }
  const parts = input.split(",").map((part) => part.trim());
  if (parts.length !== 2 || !validDateTime(parts[0]) || !validDateTime(parts[1])) {
    return null;
  }
  return parts[0] <= parts[1] ? `${parts[0]},${parts[1]}` : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactItem(value: unknown): Record<string, unknown> | null {
  const item = asRecord(value);
  if (!item) {
    return null;
  }
  return {
    rank: item.rank,
    title: item.title,
    platform: item.platform_en,
    score: item.score,
    url: item.kw_url,
    beginTime: item.begin_rank_time,
    endTime: item.end_rank_time,
    maxRank: item.max_rank,
    maxScore: item.max_score,
    duration: item.duration,
  };
}

export async function fetchHotRank(request: HotRankRequest): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_RANK_TIMEOUT_MS);
  try {
    const response = await fetch(HOT_RANK_API_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Hot-rank API returned HTTP ${response.status}`);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export function createHotRankToolFactory(
  api: OpenClawPluginApi,
  fetcher: HotRankFetcher = fetchHotRank,
  now: () => Date = () => new Date(),
) {
  return (ctx: { agentId?: string }) => {
    if (!extractUserId(ctx.agentId)) {
      return null;
    }
    return {
      name: "hot_rank",
      label: "查询热榜",
      description:
        "查询多平台热榜数据。当用户提到热榜、热搜、榜单、热门话题、实时热点、平台排行、浏览器榜或同城榜时使用本工具。" +
        "支持按日期、关键词、城市、平台和榜单类型筛选；默认查询北京时间当天的综合热榜。",
      parameters: HotRankSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const date = resolveDateRange(rawParams.date, now());
        if (!date) {
          return jsonResult({
            success: false,
            error: "日期格式无效，请使用 YYYY-MM-DD 或完整的起止时间范围。",
          });
        }
        const rankType =
          rawParams.rankType === 2 || rawParams.rankType === 3 ? rawParams.rankType : 1;
        const limit = Math.min(
          MAX_LIMIT,
          Math.max(1, Math.floor(Number(rawParams.limit) || DEFAULT_LIMIT)),
        );
        const request: HotRankRequest = {
          date,
          keyword: typeof rawParams.keyword === "string" ? rawParams.keyword.trim() : "",
          city: typeof rawParams.city === "string" ? rawParams.city.trim() : "",
          platform: typeof rawParams.platform === "string" ? rawParams.platform : "",
          rank_type: rankType,
        };
        try {
          const response = asRecord(await fetcher(request));
          if (!response || response.code !== 0 || !Array.isArray(response.data)) {
            throw new Error("Unexpected hot-rank response");
          }
          const items = response.data
            .map((item) => compactItem(item))
            .filter((item): item is Record<string, unknown> => item !== null);
          return jsonResult({
            success: true,
            date,
            filters: {
              keyword: request.keyword || undefined,
              city: request.city || undefined,
              platform: request.platform || undefined,
              rankType,
            },
            total: items.length,
            returned: Math.min(limit, items.length),
            items: items.slice(0, limit),
          });
        } catch (error) {
          api.logger.warn(
            `[leading-v2] hot_rank request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return jsonResult({ success: false, error: "热榜服务暂时不可用，请稍后重试。" });
        }
      },
    };
  };
}
