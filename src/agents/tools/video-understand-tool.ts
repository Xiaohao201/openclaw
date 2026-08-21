import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { MediaUnderstandingConfig } from "../../config/types.tools.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingOutput,
} from "../../media-understanding/types.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";
import {
  acquireVideo,
  compressForWholeVideo,
  extractAudioTrack,
  type ExtractedFrame,
  extractFrames,
  formatTimestamp,
  hasFfmpeg,
  probeVideo,
  type VideoProbe,
  VideoAcquisitionError,
  VIDEO_MAX_DURATION_SECONDS,
  WHOLE_VIDEO_MAX_DURATION_SECONDS,
  WHOLE_VIDEO_TARGET_BYTES,
} from "./video-understand.runtime.js";
import { fetchWithWebToolsNetworkGuard } from "./web-guarded-fetch.js";
import { detectVideoCandidates, resolveVideoPlatform } from "./web-video-detect.js";

const log = createSubsystemLogger("video-understand-tool");

/**
 * `video_understand` — download the video behind a URL and fold its content into
 * the agent's context.
 *
 * Two routes, picked from the clip's own dimensions:
 *
 * - **whole-video** (≤2 min and compressible under the endpoint's byte budget):
 *   one multimodal call over the actual video, which preserves motion and
 *   sequencing.
 * - **decomposed** (everything longer): ffmpeg splits the clip into an audio
 *   track for transcription and a sampled frame timeline for visual/OCR
 *   description. Transcription is the load-bearing signal for news and 舆情
 *   material — it is what the video actually *says*.
 *
 * Both routes return the same shape so downstream prompts do not branch.
 */

/** Long enough for a full transcript; the 500-char media default truncates mid-sentence. */
const TRANSCRIPT_MAX_CHARS = 20_000;
const DESCRIPTION_MAX_CHARS = 4_000;
const FRAME_DESCRIPTION_MAX_CHARS = 600;
const DEFAULT_MAX_FRAMES = 6;
const MAX_FRAMES_CAP = 24;
const DEFAULT_FRAME_INTERVAL_SECONDS = 15;
const PAGE_FETCH_MAX_BYTES = 2_000_000;
const PAGE_FETCH_TIMEOUT_SECONDS = 30;

const DEFAULT_VIDEO_PROMPT =
  "Describe this video in detail: what happens, who appears, what is said, " +
  "any on-screen text or captions, watermarks or channel logos, and the setting. " +
  "Answer in the language of the video's own content.";
const DEFAULT_FRAME_PROMPT =
  "Describe this video frame: the scene, people, actions, and transcribe any " +
  "on-screen text, captions, or watermarks verbatim. Answer in the language of the text shown.";
const DEFAULT_TRANSCRIPT_PROMPT = "Transcribe the speech in this audio.";
const VIDEO_PROVIDER_HINT =
  "整片理解未返回内容。请配置 tools.media.video 及对应密钥；推荐 qwen/qwen-vl-max-latest，" +
  "并确保网关进程可读取 QWEN_API_KEY（需使用 DashScope Standard 按量付费密钥）。";
const IMAGE_PROVIDER_HINT =
  "关键帧描述未返回内容。请配置 tools.media.image 及对应密钥；推荐 qwen/qwen-vl-max-latest，" +
  "并确保网关进程可读取 QWEN_API_KEY（需使用 DashScope Standard 按量付费密钥）。";

const VideoUnderstandSchema = Type.Object({
  url: Type.String({
    description:
      "Video URL, or the page URL containing it. Page URLs are scanned and the main video is picked automatically.",
  }),
  prompt: Type.Optional(
    Type.String({
      description: "What to look for in the video. Defaults to a general content description.",
    }),
  ),
  maxFrames: Type.Optional(
    Type.Number({
      description:
        `Frames to sample on the decomposed route (automatic: about one per ` +
        `${DEFAULT_FRAME_INTERVAL_SECONDS}s, up to ${DEFAULT_MAX_FRAMES}; max ${MAX_FRAMES_CAP}).`,
      minimum: 1,
    }),
  ),
});

export type VideoUnderstandRoute = "whole-video" | "decomposed";

export type VideoUnderstandResult = {
  sourceUrl: string;
  resolvedVideoUrl: string;
  platform?: string;
  title?: string;
  durationSeconds?: number;
  resolution?: string;
  route: VideoUnderstandRoute;
  description?: string;
  transcript?: string;
  frames: Array<{ at: string; description: string }>;
  snapshots: Array<{ at: string; path: string }>;
  markdown: string;
  warnings: string[];
};

export type VideoUnderstandToolDeps = {
  acquire: typeof acquireVideo;
  probe: typeof probeVideo;
  compress: typeof compressForWholeVideo;
  extractAudio: typeof extractAudioTrack;
  sampleFrames: typeof extractFrames;
  saveFrame: (frame: ExtractedFrame) => Promise<string>;
  ffmpegAvailable: () => boolean;
  fetchPageHtml: (url: string) => Promise<string | null>;
  describeMedia: (params: DescribeMediaParams) => Promise<MediaUnderstandingOutput[]>;
};

export type DescribeMediaParams = {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  agentDir?: string;
  files: Array<{ path: string; mime: string }>;
  prompt: string;
  maxChars: number;
  maxAttachments: number;
  localRoot: string;
};

/**
 * Run one media-understanding capability over local files.
 *
 * Reuses the existing provider registry, auto-selection, key rotation and proxy
 * handling rather than calling providers directly — the only overrides are the
 * per-call limits, since the inbound-attachment defaults (1 attachment, 500
 * output chars) are far too tight for video analysis.
 */
async function describeLocalMedia(
  params: DescribeMediaParams,
): Promise<MediaUnderstandingOutput[]> {
  // Loaded on demand: the provider registry pulls in every media provider, and a
  // session that never analyzes a video should not pay for that at startup.
  const { buildProviderRegistry, createMediaAttachmentCache, runCapability } =
    await import("../../media-understanding/runner.js");
  const attachments: MediaAttachment[] = params.files.map((file, index) => ({
    index,
    path: file.path,
    mime: file.mime,
  }));
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: [params.localRoot],
  });
  const config: MediaUnderstandingConfig = {
    ...params.cfg.tools?.media?.[params.capability],
    enabled: true,
    prompt: params.prompt,
    maxChars: params.maxChars,
    // Scope rules gate inbound chat attachments; an agent-invoked tool call has
    // already passed tool-policy gating, so scope must not silently drop it.
    scope: undefined,
    attachments: { mode: "all", maxAttachments: params.maxAttachments },
  };
  const ctx: MsgContext = {};
  const result = await runCapability({
    capability: params.capability,
    cfg: params.cfg,
    ctx,
    attachments: cache,
    media: attachments,
    agentDir: params.agentDir,
    providerRegistry: buildProviderRegistry(undefined, params.cfg),
    config,
  });
  try {
    await cache.cleanup();
  } catch {
    // Temp cleanup is best-effort.
  }
  return result.outputs;
}

async function fetchPageHtmlDefault(url: string): Promise<string | null> {
  try {
    const { response, release } = await fetchWithWebToolsNetworkGuard({
      url,
      timeoutSeconds: PAGE_FETCH_TIMEOUT_SECONDS,
      maxRedirects: 3,
    });
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/html")) {
        return null;
      }
      const body = await response.text();
      return body.slice(0, PAGE_FETCH_MAX_BYTES);
    } finally {
      await release();
    }
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: VideoUnderstandToolDeps = {
  acquire: acquireVideo,
  probe: probeVideo,
  compress: compressForWholeVideo,
  extractAudio: extractAudioTrack,
  sampleFrames: extractFrames,
  saveFrame: async (frame) => {
    const { saveMediaBuffer } = await import("../../media/store.js");
    const buffer = await fs.readFile(frame.path);
    const timestamp = formatTimestamp(frame.atSeconds).replace(":", "-");
    const saved = await saveMediaBuffer(
      buffer,
      "image/jpeg",
      "tool-video-understand",
      undefined,
      `frame-${timestamp}.jpg`,
    );
    return saved.path;
  },
  ffmpegAvailable: hasFfmpeg,
  fetchPageHtml: fetchPageHtmlDefault,
  describeMedia: describeLocalMedia,
};

const DIRECT_MEDIA_RE = /\.(?:mp4|m4v|mov|webm|ogv|avi|flv|mkv|m3u8|mpd)(?:$|[?#])/i;

/**
 * Turn the caller's URL into something acquirable: a direct media URL and a
 * platform page are used as-is, an article URL is scanned for its main video.
 */
async function resolveTargetUrl(params: {
  url: string;
  deps: VideoUnderstandToolDeps;
  warnings: string[];
}): Promise<{ url: string; title?: string }> {
  if (DIRECT_MEDIA_RE.test(params.url) || resolveVideoPlatform(params.url)) {
    return { url: params.url };
  }
  const html = await params.deps.fetchPageHtml(params.url);
  if (!html) {
    // Not HTML (or unreachable): hand the URL to the acquisition layer anyway —
    // an extension-less CDN URL is still worth a try.
    return { url: params.url };
  }
  const detection = await detectVideoCandidates({ html, url: params.url });
  if (!detection.main) {
    throw new ToolInputError(
      `页面中没有检测到视频：${params.url}。若已知视频直链，请直接传入直链。`,
    );
  }
  if (detection.ambiguous) {
    params.warnings.push(
      `页面存在多个视频且主视频判定不确定，本次分析的是 ${detection.main.url}；` +
        `其他候选：${detection.others.map((item) => item.url).join(", ")}`,
    );
  }
  return { url: detection.main.url, title: detection.main.title };
}

function buildMarkdown(result: Omit<VideoUnderstandResult, "markdown">): string {
  const lines: string[] = ["## 视频内容分析"];
  lines.push(`- 来源：${result.sourceUrl}`);
  if (result.resolvedVideoUrl !== result.sourceUrl) {
    lines.push(`- 视频地址：${result.resolvedVideoUrl}`);
  }
  if (result.platform) {
    lines.push(`- 平台：${result.platform}`);
  }
  if (result.title) {
    lines.push(`- 标题：${result.title}`);
  }
  if (result.durationSeconds) {
    lines.push(`- 时长：${formatTimestamp(result.durationSeconds)}`);
  }
  if (result.resolution) {
    lines.push(`- 分辨率：${result.resolution}`);
  }
  lines.push(
    `- 分析方式：${result.route === "whole-video" ? "整片多模态理解" : "音轨转写 + 关键帧"}`,
  );

  if (result.description) {
    lines.push("", "### 内容描述", result.description);
  }
  if (result.transcript) {
    lines.push("", "### 语音转写", result.transcript);
  }
  if (result.frames.length > 0) {
    lines.push("", "### 画面时间线");
    for (const frame of result.frames) {
      lines.push(`- **${frame.at}** ${frame.description}`);
    }
  }
  if (result.snapshots.length > 0) {
    lines.push("", "### 关键帧截图");
    for (const snapshot of result.snapshots) {
      lines.push(`- **${snapshot.at}** MEDIA:${snapshot.path}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("", "### 说明");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}

async function analyzeWholeVideo(params: {
  filePath: string;
  workDir: string;
  probe: VideoProbe;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
  warnings: string[];
}): Promise<string | undefined> {
  let target = params.filePath;
  if (params.probe.sizeBytes > WHOLE_VIDEO_TARGET_BYTES) {
    target = await params.deps.compress({
      inputPath: params.filePath,
      workDir: params.workDir,
      durationSeconds: params.probe.durationSeconds,
    });
    const compressed = await fs.stat(target).catch(() => null);
    if (compressed && compressed.size > WHOLE_VIDEO_TARGET_BYTES) {
      params.warnings.push("压缩后仍超出整片理解的体积上限，已改用音轨+关键帧方式。");
      return undefined;
    }
  }
  const outputs = await params.deps.describeMedia({
    capability: "video",
    cfg: params.cfg,
    agentDir: params.agentDir,
    files: [{ path: target, mime: "video/mp4" }],
    prompt: params.prompt,
    maxChars: DESCRIPTION_MAX_CHARS,
    maxAttachments: 1,
    localRoot: params.workDir,
  });
  const description = normalizeOptionalString(outputs[0]?.text);
  if (!description) {
    params.warnings.push(VIDEO_PROVIDER_HINT);
  }
  return description;
}

function resolveFrameBudget(
  durationSeconds: number | undefined,
  requestedMaxFrames?: number,
): number {
  if (requestedMaxFrames !== undefined) {
    return Math.max(1, Math.min(MAX_FRAMES_CAP, Math.floor(requestedMaxFrames)));
  }
  if (!durationSeconds || !Number.isFinite(durationSeconds)) {
    return DEFAULT_MAX_FRAMES;
  }
  return Math.max(
    1,
    Math.min(DEFAULT_MAX_FRAMES, Math.ceil(durationSeconds / DEFAULT_FRAME_INTERVAL_SECONDS)),
  );
}

async function analyzeAudioTrack(params: {
  filePath: string;
  workDir: string;
  hasAudio: boolean;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
}): Promise<{ transcript?: string; warnings: string[] }> {
  const warnings: string[] = [];
  if (!params.hasAudio) {
    return { warnings: ["该视频没有音轨，只能依据画面分析。"] };
  }

  try {
    const audioPath = await params.deps.extractAudio({
      inputPath: params.filePath,
      workDir: params.workDir,
    });
    const outputs = await params.deps.describeMedia({
      capability: "audio",
      cfg: params.cfg,
      agentDir: params.agentDir,
      files: [{ path: audioPath, mime: "audio/mpeg" }],
      prompt: DEFAULT_TRANSCRIPT_PROMPT,
      maxChars: TRANSCRIPT_MAX_CHARS,
      maxAttachments: 1,
      localRoot: params.workDir,
    });
    const transcript = normalizeOptionalString(outputs[0]?.text);
    if (!transcript) {
      warnings.push("音轨转写未返回内容（可能没有配置语音转写 provider，或视频无人声）。");
    }
    return { transcript, warnings };
  } catch (error) {
    return { warnings: [`音轨转写失败：${formatErrorMessage(error)}`] };
  }
}

async function analyzeFrameTimeline(params: {
  filePath: string;
  workDir: string;
  durationSeconds: number;
  prompt: string;
  maxFrames: number;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
}): Promise<{
  frames: Array<{ at: string; description: string }>;
  snapshots: Array<{ at: string; path: string }>;
  warnings: string[];
}> {
  const warnings: string[] = [];
  if (params.durationSeconds <= 0) {
    return { frames: [], snapshots: [], warnings };
  }

  let sampled: ExtractedFrame[] = [];
  try {
    sampled = await params.deps.sampleFrames({
      inputPath: params.filePath,
      workDir: params.workDir,
      durationSeconds: params.durationSeconds,
      maxFrames: params.maxFrames,
    });
  } catch (error) {
    return {
      frames: [],
      snapshots: [],
      warnings: [`关键帧抽取失败：${formatErrorMessage(error)}`],
    };
  }

  if (sampled.length === 0) {
    return { frames: [], snapshots: [], warnings };
  }

  const saveSnapshots = async (): Promise<Array<{ at: string; path: string }>> => {
    const settled = await Promise.allSettled(sampled.map((frame) => params.deps.saveFrame(frame)));
    const snapshots: Array<{ at: string; path: string }> = [];
    for (const [index, result] of settled.entries()) {
      const frame = sampled[index];
      if (result.status === "fulfilled" && frame) {
        snapshots.push({ at: formatTimestamp(frame.atSeconds), path: result.value });
      }
    }
    const failed = settled.length - snapshots.length;
    if (failed > 0) {
      warnings.push(`有 ${failed} 张关键帧截图未能保存。`);
    }
    return snapshots;
  };

  try {
    const outputs = await params.deps.describeMedia({
      capability: "image",
      cfg: params.cfg,
      agentDir: params.agentDir,
      files: sampled.map((frame) => ({ path: frame.path, mime: "image/jpeg" })),
      prompt: `${params.prompt}\n\n${DEFAULT_FRAME_PROMPT}`,
      maxChars: FRAME_DESCRIPTION_MAX_CHARS,
      maxAttachments: sampled.length,
      localRoot: params.workDir,
    });
    const frames: Array<{ at: string; description: string }> = [];
    for (const output of outputs) {
      const frame = sampled[output.attachmentIndex];
      const description = normalizeOptionalString(output.text);
      if (frame && description) {
        frames.push({ at: formatTimestamp(frame.atSeconds), description });
      }
    }
    if (frames.length === 0) {
      warnings.push(IMAGE_PROVIDER_HINT);
      return { frames, snapshots: await saveSnapshots(), warnings };
    }
    return { frames, snapshots: [], warnings };
  } catch (error) {
    const snapshots = await saveSnapshots();
    return {
      frames: [],
      snapshots,
      warnings: [
        `关键帧描述失败：${formatErrorMessage(error)}。请检查 tools.media.image、QWEN_API_KEY、网络和模型额度。`,
        ...warnings,
      ],
    };
  }
}

async function analyzeDecomposed(params: {
  filePath: string;
  workDir: string;
  probe: VideoProbe;
  prompt: string;
  maxFrames: number;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
  warnings: string[];
}): Promise<{
  transcript?: string;
  frames: Array<{ at: string; description: string }>;
  snapshots: Array<{ at: string; path: string }>;
}> {
  const duration = params.probe.durationSeconds ?? 0;
  const [audio, visual] = await Promise.all([
    analyzeAudioTrack({
      filePath: params.filePath,
      workDir: params.workDir,
      hasAudio: params.probe.hasAudio,
      cfg: params.cfg,
      agentDir: params.agentDir,
      deps: params.deps,
    }),
    analyzeFrameTimeline({
      filePath: params.filePath,
      workDir: params.workDir,
      durationSeconds: duration,
      prompt: params.prompt,
      maxFrames: params.maxFrames,
      cfg: params.cfg,
      agentDir: params.agentDir,
      deps: params.deps,
    }),
  ]);
  // Keep warning order deterministic even though the expensive work runs concurrently.
  params.warnings.push(...audio.warnings, ...visual.warnings);
  return { transcript: audio.transcript, frames: visual.frames, snapshots: visual.snapshots };
}

export async function runVideoUnderstand(params: {
  url: string;
  prompt?: string;
  maxFrames?: number;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps?: Partial<VideoUnderstandToolDeps>;
}): Promise<VideoUnderstandResult> {
  const deps: VideoUnderstandToolDeps = { ...DEFAULT_DEPS, ...params.deps };
  if (!deps.ffmpegAvailable()) {
    throw new ToolInputError(
      "视频分析需要 ffmpeg（含 ffprobe），但没在可信目录里找到——出于防 PATH 劫持的考虑，OpenClaw 不读取 PATH。" +
        "请把 ffmpeg 装到系统目录（Windows：<Program Files>\\ffmpeg\\bin），" +
        "或设置环境变量 OPENCLAW_SYSTEM_BIN_DIRS 指向 ffmpeg 所在目录后重启网关。",
    );
  }
  const warnings: string[] = [];
  const prompt = normalizeOptionalString(params.prompt) ?? DEFAULT_VIDEO_PROMPT;
  const requestedMaxFrames = params.maxFrames;

  const target = await resolveTargetUrl({ url: params.url, deps, warnings });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-video-"));

  try {
    const acquired = await deps.acquire({ url: target.url, workDir });
    const probe = await deps.probe(acquired.path);

    if (probe.durationSeconds && probe.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
      throw new ToolInputError(
        `视频时长 ${formatTimestamp(probe.durationSeconds)} 超出上限 ` +
          `${formatTimestamp(VIDEO_MAX_DURATION_SECONDS)}，请改用更短的片段。`,
      );
    }

    const shortEnough =
      probe.durationSeconds !== undefined &&
      probe.durationSeconds <= WHOLE_VIDEO_MAX_DURATION_SECONDS;

    let route: VideoUnderstandRoute = shortEnough ? "whole-video" : "decomposed";
    let description: string | undefined;
    if (route === "whole-video") {
      try {
        description = await analyzeWholeVideo({
          filePath: acquired.path,
          workDir,
          probe,
          prompt,
          cfg: params.cfg,
          agentDir: params.agentDir,
          deps,
          warnings,
        });
      } catch (error) {
        warnings.push(`整片理解失败，已回退到音轨+关键帧：${formatErrorMessage(error)}`);
      }
      if (!description) {
        route = "decomposed";
      }
    }

    const decomposed =
      route === "decomposed"
        ? await analyzeDecomposed({
            filePath: acquired.path,
            workDir,
            probe,
            prompt,
            maxFrames: resolveFrameBudget(probe.durationSeconds, requestedMaxFrames),
            cfg: params.cfg,
            agentDir: params.agentDir,
            deps,
            warnings,
          })
        : { transcript: undefined, frames: [], snapshots: [] };

    if (
      !description &&
      !decomposed.transcript &&
      decomposed.frames.length === 0 &&
      decomposed.snapshots.length === 0
    ) {
      throw new Error(
        `视频已取回但没有任何分析结果。${warnings.length > 0 ? warnings.join(" ") : ""}`.trim(),
      );
    }

    const base: Omit<VideoUnderstandResult, "markdown"> = {
      sourceUrl: params.url,
      resolvedVideoUrl: acquired.sourceUrl,
      platform: acquired.platform,
      title: acquired.title ?? target.title,
      durationSeconds: probe.durationSeconds,
      resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : undefined,
      route,
      description,
      transcript: decomposed.transcript,
      frames: decomposed.frames,
      snapshots: decomposed.snapshots,
      warnings,
    };
    return { ...base, markdown: buildMarkdown(base) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createVideoUnderstandTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  agentSessionKey?: string;
  deps?: Partial<VideoUnderstandToolDeps>;
}): AnyAgentTool {
  return {
    label: "Video Understand",
    name: "video_understand",
    description:
      "Download the video behind a URL and analyze its content. Accepts a direct video URL, an HLS manifest, " +
      "a platform watch page (抖音/哔哩哔哩/微博/快手/YouTube…), or an article URL whose main video is detected automatically. " +
      "Short clips are analyzed whole by a multimodal model; longer ones are transcribed and sampled into a frame timeline. " +
      "If visual understanding is unavailable, saved keyframes are returned as MEDIA paths that can be shown to the user.",
    parameters: VideoUnderstandSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const prompt = readStringParam(params, "prompt");
      const maxFrames = readNumberParam(params, "maxFrames", { integer: true });
      try {
        const result = await runVideoUnderstand({
          url,
          prompt,
          maxFrames: maxFrames ?? undefined,
          cfg: options?.config ?? ({} as OpenClawConfig),
          agentDir: options?.agentDir,
          deps: options?.deps,
        });
        log.info(
          `video_understand: ${result.route} for ${result.resolvedVideoUrl} ` +
            `(session=${options?.agentSessionKey ?? "unknown"}, frames=${result.frames.length})`,
        );
        return jsonResult({
          ...result,
          // Model-authored text about untrusted web media: same containment as
          // web_fetch, so injected instructions inside a video cannot steer the agent.
          markdown: wrapExternalContent(result.markdown, {
            source: "web_fetch",
            includeWarning: true,
          }),
        });
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        if (error instanceof VideoAcquisitionError) {
          throw new ToolInputError(
            error.hint ? `${error.message}（${error.hint}）` : error.message,
          );
        }
        log.warn(`video_understand failed for ${url}: ${formatErrorMessage(error)}`);
        throw error;
      }
    },
  };
}
