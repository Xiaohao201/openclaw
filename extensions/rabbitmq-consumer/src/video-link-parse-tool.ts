import { z } from "zod";
import {
  isPrivateIpAddress,
  jsonResult,
  type AnyAgentTool,
  type OpenClawPluginApi,
  wrapExternalContent,
} from "../api.js";

const QY_VIDEO_PARSE_ENDPOINT = "https://qyapi.ipaybuy.cn/api/video";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const WECHAT_CHANNEL_SHORT_HOSTS = new Set(["weixin.qq.com", "www.weixin.qq.com"]);
const WECHAT_CHANNEL_SHORT_PATH = /^\/sph\/([A-Za-z0-9_-]{1,128})\/?$/u;
const BARE_WECHAT_CHANNEL_SHORT_URL =
  /(?:^|\[|[\s（(【：:])((?:www\.)?weixin\.qq\.com\/sph\/[A-Za-z0-9_-]{1,128}(?:\?[^\s<>"']*)?)(?=$|\]|[\s<>"'）)】,，。！？；：])/iu;

const VideoLinkParseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      minLength: 1,
      description:
        "短视频链接或包含一个短视频链接的分享文案。支持抖音、快手、小红书、视频号、B站、微博等平台；视频号 weixin.qq.com/sph/ 短链可省略协议。",
    },
  },
  required: ["url"],
} as const;

const TextField = z.string().max(20_000).optional();
const VendorResponseSchema = z.object({
  code: z
    .union([z.number(), z.string().regex(/^\d+$/)])
    .transform((value) => (typeof value === "number" ? value : Number(value))),
  msg: z.string().max(1_000).optional(),
  data: z
    .object({
      video_url: TextField,
      cover_url: TextField,
      title: z.string().max(4_000).optional(),
      music_url: TextField,
      content: TextField,
      images: z
        .array(
          z.object({
            url: TextField,
            live_photo_url: TextField,
          }),
        )
        .max(100)
        .optional(),
      author: z
        .object({
          uid: z.string().max(1_000).optional(),
          name: z.string().max(4_000).optional(),
          avatar: TextField,
        })
        .optional(),
    })
    .optional(),
});

const VENDOR_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1001: "视频解析服务凭证无效。",
  1005: "视频解析服务账号异常。",
  3000: "视频解析服务尚未开通或已过期。",
  3001: "视频解析请求过于频繁，请稍后重试。",
  3002: "调用次数不足",
  3003: "今日视频解析调用次数已达上限。",
};

export type VideoParserConfig = {
  appId: string;
  appKey: string;
  timeoutMs: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export function resolveVideoParserConfig(
  env: NodeJS.ProcessEnv = process.env,
): VideoParserConfig | undefined {
  const appId = trimmed(env.QY_VIDEO_APP_ID);
  const appKey = trimmed(env.QY_VIDEO_APP_KEY);
  if (!appId || !appKey) {
    return undefined;
  }
  const configuredSeconds = Number(env.QY_VIDEO_TIMEOUT_SECONDS);
  const timeoutMs =
    Number.isFinite(configuredSeconds) && configuredSeconds > 0
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(configuredSeconds * 1_000)))
      : DEFAULT_TIMEOUT_MS;
  return { appId, appKey, timeoutMs };
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    isPrivateIpAddress(normalized)
  );
}

function normalizePublicHttpUrl(value: string | undefined): string | undefined {
  const normalized = trimmed(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      isPrivateHostname(parsed.hostname)
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

function extractPublicVideoUrl(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalizedInput = input.trim();
  const explicitMatch = normalizedInput.match(/https?:\/\/[^\s<>"']+/iu);
  const bareWechatMatch = explicitMatch
    ? undefined
    : normalizedInput.match(BARE_WECHAT_CHANNEL_SHORT_URL);
  const candidate = (explicitMatch?.[0] ?? bareWechatMatch?.[1])?.replace(
    /[\])}>,，。！？；：]+$/u,
    "",
  );
  if (!candidate) {
    return undefined;
  }
  return normalizePublicHttpUrl(explicitMatch ? candidate : `https://${candidate}`);
}

type VideoTarget = {
  sourceUrl: string;
  resolvedUrl: string;
};

function resolveVideoTarget(sourceUrl: string): VideoTarget | undefined {
  const parsed = new URL(sourceUrl);
  if (!WECHAT_CHANNEL_SHORT_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { sourceUrl, resolvedUrl: sourceUrl };
  }

  const shortPath = parsed.pathname.match(WECHAT_CHANNEL_SHORT_PATH);
  if (!shortPath) {
    return undefined;
  }

  const shareId = shortPath[1];
  if (!shareId) {
    return undefined;
  }
  const expanded = new URL("https://channels.weixin.qq.com/finder-preview/pages/sph");
  expanded.searchParams.set("id", shareId);
  return { sourceUrl, resolvedUrl: expanded.href };
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("response_too_large");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function externalText(value: string | undefined): string | undefined {
  const normalized = trimmed(value);
  return normalized
    ? wrapExternalContent(normalized, { source: "web_fetch", includeWarning: false })
    : undefined;
}

function safeFailure(error: string, code?: number) {
  return jsonResult({ success: false, ...(code === undefined ? {} : { code }), error });
}

export function createVideoLinkParseTool(options: {
  config: VideoParserConfig;
  fetchImpl?: FetchLike;
  logger?: Pick<OpenClawPluginApi["logger"], "warn">;
}): AnyAgentTool {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    name: "video_link_parse",
    label: "视频链接解析",
    description:
      "解析抖音、快手、小红书、视频号、B站、微博等平台的短视频分享链接，返回无水印视频直链、封面、标题、作者和图集。" +
      "视频号 weixin.qq.com/sph/ 短链会自动展开为可解析的 channels.weixin.qq.com 地址。" +
      "收到平台分享链接且需要读取视频时先调用本工具；当 web_fetch 失败、只返回页面外壳或没有取得视频媒体时，应自主调用本工具兜底，无需询问用户。" +
      "如需理解视频口播、字幕或画面，再把返回的 video_url 交给 video_understand。",
    parameters: VideoLinkParseSchema,
    async execute(_toolCallId, rawParams) {
      const sourceUrl = extractPublicVideoUrl((rawParams as Record<string, unknown>).url);
      const target = sourceUrl ? resolveVideoTarget(sourceUrl) : undefined;
      if (!target) {
        return safeFailure("请提供一个公开的 http(s) 短视频链接；不支持本地或私网地址。");
      }
      try {
        const response = await fetchImpl(QY_VIDEO_PARSE_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            appId: options.config.appId,
            appKey: options.config.appKey,
            url: target.resolvedUrl,
          }),
          signal: AbortSignal.timeout(options.config.timeoutMs),
        });
        if (!response.ok) {
          return safeFailure(`视频解析服务请求失败（HTTP ${response.status}）。`);
        }

        const rawBody = await readBoundedText(response);
        let decoded: unknown;
        try {
          decoded = JSON.parse(rawBody);
        } catch {
          return safeFailure("视频解析服务返回了无法识别的数据。");
        }
        const parsed = VendorResponseSchema.safeParse(decoded);
        if (!parsed.success) {
          return safeFailure("视频解析服务返回了不完整的数据。");
        }
        if (parsed.data.code !== 200) {
          return safeFailure(
            VENDOR_ERROR_MESSAGES[parsed.data.code] ??
              `视频解析服务返回错误（code ${parsed.data.code}）。`,
            parsed.data.code,
          );
        }
        const data = parsed.data.data;
        const videoUrl = normalizePublicHttpUrl(data?.video_url);
        const images = (data?.images ?? [])
          .map((item) => ({
            url: normalizePublicHttpUrl(item.url),
            live_photo_url: normalizePublicHttpUrl(item.live_photo_url),
          }))
          .filter((item) => item.url || item.live_photo_url);
        if (!data || (!videoUrl && images.length === 0)) {
          return safeFailure("视频链接已解析，但服务没有返回可用的视频或图集地址。");
        }

        return jsonResult({
          success: true,
          source_url: target.sourceUrl,
          resolved_url: target.resolvedUrl,
          video_url: videoUrl,
          cover_url: normalizePublicHttpUrl(data.cover_url),
          music_url: normalizePublicHttpUrl(data.music_url),
          title: externalText(data.title),
          content: externalText(data.content),
          author: data.author
            ? {
                uid: trimmed(data.author.uid),
                name: externalText(data.author.name),
                avatar: normalizePublicHttpUrl(data.author.avatar),
              }
            : undefined,
          images,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "UnknownError";
        options.logger?.warn(`[VIDEO_LINK_PARSE] request failed (${reason})`);
        return safeFailure(
          error instanceof Error && error.message === "response_too_large"
            ? "视频解析服务返回的数据过大，已拒绝处理。"
            : "视频解析服务暂时不可用，请稍后重试。",
        );
      }
    },
  };
}

export function createVideoLinkParseToolFactory(api: OpenClawPluginApi) {
  const config = resolveVideoParserConfig();
  if (!config) {
    api.logger.info(
      "[VIDEO_LINK_PARSE] QY_VIDEO_APP_ID/QY_VIDEO_APP_KEY not configured; tool disabled",
    );
  }
  return () => (config ? createVideoLinkParseTool({ config, logger: api.logger }) : null);
}
