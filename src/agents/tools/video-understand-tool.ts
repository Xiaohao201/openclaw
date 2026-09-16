import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { MediaUnderstandingConfig } from "../../config/types.tools.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
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
  splitVideoIntoSegments,
  type VideoSegment,
  type VideoProbe,
  VideoAcquisitionError,
  VIDEO_MAX_DURATION_SECONDS,
  WHOLE_VIDEO_TARGET_BYTES,
  WHOLE_VIDEO_COMPRESSION_THRESHOLD_BYTES,
} from "./video-understand.runtime.js";
import { fetchWithWebToolsNetworkGuard } from "./web-guarded-fetch.js";
import { detectVideoCandidates, resolveVideoPlatform } from "./web-video-detect.js";

const log = createSubsystemLogger("video-understand-tool");

/**
 * `video_understand` — download the video behind a URL and fold its content into
 * the agent's context.
 *
 * Prefer whole-video multimodal understanding. Videos over ten minutes get one
 * whole-video attempt and then overlapping model-analyzed segments. Audio and
 * sampled frames are the final fallback.
 *
 * Both routes return the same shape so downstream prompts do not branch.
 */

/** Long enough for a full transcript; the 500-char media default truncates mid-sentence. */
const TRANSCRIPT_MAX_CHARS = 20_000;
const DESCRIPTION_MAX_CHARS = 4_000;
const FRAME_DESCRIPTION_MAX_CHARS = 600;
const DEFAULT_MAX_FRAMES = 6;
const MAX_FRAMES_CAP = 24;
const FALLBACK_FRAMES_PER_MINUTE = 2;
const SHORT_VIDEO_MAX_SECONDS = 2 * 60;
const MEDIUM_VIDEO_MAX_SECONDS = 10 * 60;
const SHORT_VIDEO_TIMEOUT_SECONDS = 180;
const MEDIUM_VIDEO_TIMEOUT_SECONDS = 480;
const LONG_VIDEO_TIMEOUT_SECONDS = 600;
const SEGMENT_SECONDS = 120;
const SEGMENT_OVERLAP_SECONDS = 5;
const SEGMENT_CONCURRENCY = 2;
const TOTAL_FLOW_TIMEOUT_MS = 30 * 60_000;
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
  "整片理解未返回内容。请配置 tools.media.video 及对应密钥；推荐 qwen/qwen3.8-flash，" +
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
        `Frames to sample on the final fallback route (automatic: two per minute, ` +
        `minimum ${DEFAULT_MAX_FRAMES}, maximum ${MAX_FRAMES_CAP}).`,
      minimum: 1,
    }),
  ),
});

export type VideoUnderstandRoute = "whole-video" | "segmented-video" | "decomposed";

export type VideoModelAttemptDiagnostic = {
  stage: "whole" | "segment";
  attempt: number;
  segmentIndex?: number;
  provider?: string;
  model?: string;
  timeoutSeconds: number;
  elapsedMs: number;
  outcome: "success" | "empty" | "failed";
  retryable: boolean;
  reason?: string;
  decision?: MediaUnderstandingDecision;
};

export type VideoAnalysisDiagnostics = {
  strategy: VideoUnderstandRoute;
  totalLimitSeconds: 1800;
  elapsedMs: number;
  attempts: VideoModelAttemptDiagnostic[];
  fallbackReason?: string;
  segmentation?: {
    segmentSeconds: 120;
    overlapSeconds: 5;
    concurrency: 2;
    totalSegments: number;
    analyzedSegments: number;
  };
};

export type VideoAudioStatus = {
  message: string;
  decision?: MediaUnderstandingDecision;
} & (
  | { status: "no-audio" | "not-requested"; extraction: "not-attempted" }
  | { status: "extraction-failed"; extraction: "failed" }
  | {
      status: "success" | "unavailable" | "skipped" | "empty" | "transcription-failed";
      extraction: "success";
    }
);

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
  audio: VideoAudioStatus;
  frames: Array<{ at: string; description: string }>;
  snapshots: Array<{ at: string; path: string }>;
  markdown: string;
  warnings: string[];
  diagnostics: VideoAnalysisDiagnostics;
};

export type VideoUnderstandToolDeps = {
  acquire: typeof acquireVideo;
  probe: typeof probeVideo;
  compress: typeof compressForWholeVideo;
  splitSegments: typeof splitVideoIntoSegments;
  extractAudio: typeof extractAudioTrack;
  sampleFrames: typeof extractFrames;
  saveFrame: (frame: ExtractedFrame) => Promise<string>;
  ffmpegAvailable: () => boolean;
  fetchPageHtml: (url: string) => Promise<string | null>;
  describeMedia: (params: DescribeMediaParams) => Promise<MediaUnderstandingOutput[]>;
  now: () => number;
};

export type DescribeMediaParams = {
  onDecision?: (decision: MediaUnderstandingDecision) => void;
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  agentDir?: string;
  files: Array<{ path: string; mime: string; url?: string }>;
  prompt: string;
  maxChars: number;
  maxAttachments: number;
  localRoot: string;
  timeoutSeconds?: number;
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
    url: file.url,
    mime: file.mime,
  }));
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: [params.localRoot],
  });
  const runtimeCfg: OpenClawConfig = params.timeoutSeconds
    ? {
        ...params.cfg,
        tools: {
          ...params.cfg.tools,
          media: {
            ...params.cfg.tools?.media,
            models: params.cfg.tools?.media?.models?.map((entry) => ({
              ...entry,
              timeoutSeconds: params.timeoutSeconds,
            })),
          },
        },
      }
    : params.cfg;
  const configured = params.cfg.tools?.media?.[params.capability];
  const config: MediaUnderstandingConfig = {
    ...configured,
    enabled: true,
    prompt: params.prompt,
    maxChars: params.maxChars,
    maxBytes:
      params.cfg.tools?.media?.[params.capability]?.maxBytes ??
      (params.capability === "video" ? WHOLE_VIDEO_COMPRESSION_THRESHOLD_BYTES : undefined),
    // Scope rules gate inbound chat attachments; an agent-invoked tool call has
    // already passed tool-policy gating, so scope must not silently drop it.
    scope: undefined,
    attachments: { mode: "all", maxAttachments: params.maxAttachments },
    timeoutSeconds: params.timeoutSeconds ?? configured?.timeoutSeconds,
    models: configured?.models?.map((entry) => ({
      ...entry,
      timeoutSeconds: params.timeoutSeconds ?? entry.timeoutSeconds,
    })),
  };
  const ctx: MsgContext = {};
  try {
    const result = await runCapability({
      capability: params.capability,
      cfg: runtimeCfg,
      ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry: buildProviderRegistry(undefined, runtimeCfg),
      config,
    });
    params.onDecision?.(result.decision);
    return result.outputs;
  } finally {
    await cache.cleanup().catch(() => {});
  }
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
  splitSegments: splitVideoIntoSegments,
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
  now: Date.now,
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
  const routeLabel =
    result.route === "whole-video"
      ? "整片多模态理解"
      : result.route === "segmented-video"
        ? "分段多模态理解"
        : result.transcript
          ? "音轨转写 + 关键帧（抽样）"
          : "关键帧分析（未获得口播转写）";
  lines.push(`- 分析方式：${routeLabel}`);
  lines.push(`- 音频处理：${result.audio.message}`);
  if (result.frames.length > 0 || result.snapshots.length > 0) {
    lines.push(`- 画面覆盖：${result.frames.length} 张抽样关键帧完成分析，并非逐帧完整覆盖。`);
  }

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

function sanitizeDecision(value: MediaUnderstandingDecision): MediaUnderstandingDecision {
  const sanitize = (
    attempt: MediaUnderstandingDecision["attachments"][number]["attempts"][number],
  ) => ({
    ...attempt,
    reason: attempt.reason ? redactSensitiveText(attempt.reason).slice(0, 1000) : undefined,
  });
  return {
    ...value,
    attachments: value.attachments.map((attachment) => ({
      ...attachment,
      attempts: attachment.attempts.map(sanitize),
      chosen: attachment.chosen ? sanitize(attachment.chosen) : undefined,
    })),
  };
}

function classifyRetryable(reason: string | undefined): boolean {
  if (!reason) {
    return true;
  }
  if (
    /(?:401|403|unauthori[sz]ed|forbidden|api.?key|credential|unsupported|not supported|413|too large|max.?bytes|content.?policy|safety|invalid request|bad request)/i.test(
      reason,
    )
  ) {
    return false;
  }
  return /(?:timeout|timed out|abort|temporary|temporarily|429|rate.?limit|5(?:00|02|03|04)|ECONN|ETIMEDOUT|ENET|network|fetch failed|socket)/i.test(
    reason,
  );
}

function pickAttemptIdentity(decision: MediaUnderstandingDecision | undefined): {
  provider?: string;
  model?: string;
  reason?: string;
} {
  const attempts = decision?.attachments.flatMap((attachment) => attachment.attempts) ?? [];
  const selected = attempts.find((attempt) => attempt.outcome === "success") ?? attempts.at(-1);
  return {
    provider: selected?.provider,
    model: selected?.model,
    reason: selected?.reason,
  };
}

function resolveWholeVideoPolicy(durationSeconds: number | undefined): {
  timeoutSeconds: number;
  maxAttempts: number;
} {
  if (durationSeconds !== undefined && durationSeconds <= SHORT_VIDEO_MAX_SECONDS) {
    return { timeoutSeconds: SHORT_VIDEO_TIMEOUT_SECONDS, maxAttempts: 3 };
  }
  if (durationSeconds !== undefined && durationSeconds <= MEDIUM_VIDEO_MAX_SECONDS) {
    return { timeoutSeconds: MEDIUM_VIDEO_TIMEOUT_SECONDS, maxAttempts: 2 };
  }
  return { timeoutSeconds: LONG_VIDEO_TIMEOUT_SECONDS, maxAttempts: 1 };
}

async function analyzeVideoModelInput(params: {
  filePath: string;
  sourceUrl?: string;
  workDir: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
  stage: "whole" | "segment";
  segmentIndex?: number;
  timeoutSeconds: number;
  maxAttempts: number;
  remainingMs: () => number;
}): Promise<{ description?: string; attempts: VideoModelAttemptDiagnostic[] }> {
  const attempts: VideoModelAttemptDiagnostic[] = [];
  for (let attempt = 1; attempt <= params.maxAttempts; attempt += 1) {
    const remainingSeconds = Math.floor(params.remainingMs() / 1000);
    if (remainingSeconds <= 0) {
      break;
    }
    const timeoutSeconds = Math.max(1, Math.min(params.timeoutSeconds, remainingSeconds));
    const startedAt = params.deps.now();
    let decision: MediaUnderstandingDecision | undefined;
    try {
      const outputs = await params.deps.describeMedia({
        onDecision: (value) => {
          decision = sanitizeDecision(value);
        },
        capability: "video",
        cfg: params.cfg,
        agentDir: params.agentDir,
        files: [{ path: params.filePath, mime: "video/mp4", url: params.sourceUrl }],
        prompt: params.prompt,
        maxChars: DESCRIPTION_MAX_CHARS,
        maxAttachments: 1,
        localRoot: params.workDir,
        timeoutSeconds,
      });
      const description = normalizeOptionalString(outputs[0]?.text);
      const output = outputs[0];
      const identity = pickAttemptIdentity(decision);
      identity.provider ??= output?.provider;
      identity.model ??= output?.model;
      const retryable = !description && classifyRetryable(identity.reason);
      attempts.push({
        stage: params.stage,
        attempt,
        segmentIndex: params.segmentIndex,
        timeoutSeconds,
        elapsedMs: Math.max(0, params.deps.now() - startedAt),
        outcome: description ? "success" : "empty",
        retryable,
        ...identity,
        decision,
      });
      if (description) {
        return { description, attempts };
      }
      if (!retryable) {
        break;
      }
    } catch (error) {
      const reason = redactSensitiveText(formatErrorMessage(error)).slice(0, 1000);
      const identity = pickAttemptIdentity(decision);
      const retryable = classifyRetryable(reason || identity.reason);
      attempts.push({
        stage: params.stage,
        attempt,
        segmentIndex: params.segmentIndex,
        timeoutSeconds,
        elapsedMs: Math.max(0, params.deps.now() - startedAt),
        outcome: "failed",
        retryable,
        provider: identity.provider,
        model: identity.model,
        reason,
        decision,
      });
      if (!retryable) {
        break;
      }
    }
  }
  return { attempts };
}

async function analyzeWholeVideo(params: {
  filePath: string;
  sourceUrl?: string;
  workDir: string;
  probe: VideoProbe;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
  warnings: string[];
  remainingMs: () => number;
}): Promise<{ description?: string; attempts: VideoModelAttemptDiagnostic[] }> {
  let target = params.filePath;
  if (params.probe.sizeBytes > WHOLE_VIDEO_COMPRESSION_THRESHOLD_BYTES) {
    target = await params.deps.compress({
      inputPath: params.filePath,
      workDir: params.workDir,
      durationSeconds: params.probe.durationSeconds,
      timeoutMs: params.remainingMs(),
    });
    const compressed = await fs.stat(target).catch(() => null);
    if (compressed && compressed.size > WHOLE_VIDEO_TARGET_BYTES) {
      params.warnings.push("压缩后仍超出整片理解的体积上限，已改用音轨+关键帧方式。");
      return { attempts: [] };
    }
  }
  const policy = resolveWholeVideoPolicy(params.probe.durationSeconds);
  const result = await analyzeVideoModelInput({
    filePath: target,
    sourceUrl: target === params.filePath ? params.sourceUrl : undefined,
    workDir: params.workDir,
    prompt: params.prompt,
    cfg: params.cfg,
    agentDir: params.agentDir,
    deps: params.deps,
    stage: "whole",
    timeoutSeconds: policy.timeoutSeconds,
    maxAttempts: policy.maxAttempts,
    remainingMs: params.remainingMs,
  });
  if (result.attempts.length > 0) {
    const last = result.attempts.at(-1);
    if (!result.description && last?.reason) {
      params.warnings.push(`整片理解未完成：${last.reason}`);
    }
  }
  if (result.description) {
    return result;
  }
  params.warnings.push(VIDEO_PROVIDER_HINT);
  return result;
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
  return Math.min(
    MAX_FRAMES_CAP,
    Math.max(DEFAULT_MAX_FRAMES, Math.ceil(durationSeconds / 60) * FALLBACK_FRAMES_PER_MINUTE),
  );
}

async function analyzeVideoSegments(params: {
  filePath: string;
  workDir: string;
  durationSeconds: number;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
  remainingMs: () => number;
}): Promise<{
  description?: string;
  attempts: VideoModelAttemptDiagnostic[];
  segments: VideoSegment[];
  analyzedSegments: number;
}> {
  const segments = await params.deps.splitSegments({
    inputPath: params.filePath,
    workDir: params.workDir,
    durationSeconds: params.durationSeconds,
    segmentSeconds: SEGMENT_SECONDS,
    overlapSeconds: SEGMENT_OVERLAP_SECONDS,
    timeoutMs: params.remainingMs(),
  });
  const results: Array<
    { description?: string; attempts: VideoModelAttemptDiagnostic[] } | undefined
  > = Array.from({ length: segments.length });
  let cursor = 0;
  const worker = async () => {
    while (cursor < segments.length) {
      const index = cursor;
      cursor += 1;
      const segment = segments[index];
      if (!segment || params.remainingMs() <= 0) {
        continue;
      }
      results[index] = await analyzeVideoModelInput({
        filePath: segment.path,
        workDir: params.workDir,
        prompt:
          `${params.prompt}\n\nThis is segment ${index + 1} of ${segments.length}, ` +
          `${formatTimestamp(segment.startSeconds)}-${formatTimestamp(segment.endSeconds)}. ` +
          "Describe only this time range; adjacent segments overlap by five seconds, so avoid treating repeated boundary content as a new event.",
        cfg: params.cfg,
        agentDir: params.agentDir,
        deps: params.deps,
        stage: "segment",
        segmentIndex: index,
        timeoutSeconds: SHORT_VIDEO_TIMEOUT_SECONDS,
        maxAttempts: 2,
        remainingMs: params.remainingMs,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, () => worker()),
  );
  const attempts = results.flatMap((result) => result?.attempts ?? []);
  const descriptions = results.flatMap((result, index) => {
    const segment = segments[index];
    return result?.description && segment
      ? [
          `**${formatTimestamp(segment.startSeconds)}–${formatTimestamp(segment.endSeconds)}** ${result.description}`,
        ]
      : [];
  });
  return {
    description: descriptions.length > 0 ? descriptions.join("\n\n") : undefined,
    attempts,
    segments,
    analyzedSegments: descriptions.length,
  };
}

async function analyzeAudioTrack(params: {
  filePath: string;
  workDir: string;
  hasAudio: boolean;
  cfg: OpenClawConfig;
  agentDir?: string;
  deps: VideoUnderstandToolDeps;
  remainingMs: () => number;
}): Promise<{ transcript?: string; audio: VideoAudioStatus; warnings: string[] }> {
  const finish = (audio: VideoAudioStatus, transcript?: string) => ({
    audio,
    transcript,
    warnings: audio.status === "success" ? [] : [audio.message],
  });
  if (!params.hasAudio) {
    return finish({
      status: "no-audio",
      extraction: "not-attempted",
      message: "该视频没有音轨，只能依据画面分析。",
    });
  }
  let audioPath: string;
  try {
    audioPath = await params.deps.extractAudio({
      inputPath: params.filePath,
      workDir: params.workDir,
      timeoutMs: params.remainingMs(),
    });
  } catch (error) {
    return finish({
      status: "extraction-failed",
      extraction: "failed",
      message: `音轨提取失败，尚未执行转写：${redactSensitiveText(formatErrorMessage(error))}`,
    });
  }
  let decision: MediaUnderstandingDecision | undefined;
  try {
    const outputs = await params.deps.describeMedia({
      onDecision: (value) => {
        decision = sanitizeDecision(value);
      },
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
    if (transcript) {
      return finish(
        {
          status: "success",
          extraction: "success",
          decision,
          message: "音轨提取成功，已获得语音转写文本。",
        },
        transcript,
      );
    }
    const attempts = decision?.attachments.flatMap((attachment) => attachment.attempts) ?? [];
    const status =
      decision?.outcome === "failed"
        ? "transcription-failed"
        : decision?.outcome === "skipped" && attempts.length === 0
          ? "unavailable"
          : decision && decision.outcome !== "success"
            ? "skipped"
            : "empty";
    const labels = {
      "transcription-failed": "转写服务执行失败",
      unavailable: "未找到可用的语音转写服务，请检查 tools.media.audio 及其凭据或本地转写程序",
      skipped: "转写被跳过",
      empty: "转写未返回文本",
    };
    const reasons = attempts
      .map(
        (attempt) =>
          `${attempt.provider ?? attempt.type}${attempt.model ? `/${attempt.model}` : ""}: ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ""}`,
      )
      .join("；");
    return finish({
      status,
      extraction: "success",
      decision,
      message: `音轨提取成功；${labels[status]}${decision ? `（状态：${decision.outcome}）` : ""}。${reasons ? `${reasons}。` : ""}未获得口播内容，不能据此判断视频没有人声。`,
    });
  } catch (error) {
    return finish({
      status: "transcription-failed",
      extraction: "success",
      decision,
      message: `音轨提取成功；音轨转写失败：${redactSensitiveText(formatErrorMessage(error))}。未获得口播内容，不能据此判断视频没有人声。`,
    });
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
  remainingMs: () => number;
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
      timeoutMs: params.remainingMs(),
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
  remainingMs: () => number;
}): Promise<{
  transcript?: string;
  audio: VideoAudioStatus;
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
      remainingMs: params.remainingMs,
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
      remainingMs: params.remainingMs,
    }),
  ]);
  // Keep warning order deterministic even though the expensive work runs concurrently.
  params.warnings.push(...audio.warnings, ...visual.warnings);
  return {
    transcript: audio.transcript,
    audio: audio.audio,
    frames: visual.frames,
    snapshots: visual.snapshots,
  };
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
  const startedAt = deps.now();
  const deadlineAt = startedAt + TOTAL_FLOW_TIMEOUT_MS;
  const remainingMs = () => Math.max(0, deadlineAt - deps.now());
  const warnings: string[] = [];
  const prompt = normalizeOptionalString(params.prompt) ?? DEFAULT_VIDEO_PROMPT;
  const requestedMaxFrames = params.maxFrames;

  const target = await resolveTargetUrl({ url: params.url, deps, warnings });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-video-"));

  try {
    const acquired = await deps.acquire({ url: target.url, workDir, timeoutMs: remainingMs() });
    // Metadata is optional for direct multimodal input; ffprobe may be absent.
    let probeFailed = false;
    const probe: VideoProbe = await deps
      .probe(acquired.path, { timeoutMs: remainingMs() })
      .catch(async () => {
        probeFailed = true;
        return { sizeBytes: (await fs.stat(acquired.path)).size, hasAudio: false };
      });

    if (probe.durationSeconds && probe.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
      throw new ToolInputError(
        `视频时长 ${formatTimestamp(probe.durationSeconds)} 超出上限 ` +
          `${formatTimestamp(VIDEO_MAX_DURATION_SECONDS)}，请改用更短的片段。`,
      );
    }

    let route: VideoUnderstandRoute = "whole-video";
    let description: string | undefined;
    const modelAttempts: VideoModelAttemptDiagnostic[] = [];
    let fallbackReason: string | undefined;
    let segmentation: VideoAnalysisDiagnostics["segmentation"];
    let needsFallback = false;
    try {
      const whole = await analyzeWholeVideo({
        filePath: acquired.path,
        sourceUrl: acquired.via === "download" ? acquired.sourceUrl : undefined,
        workDir,
        probe,
        prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        deps,
        warnings,
        remainingMs,
      });
      description = whole.description;
      modelAttempts.push(...whole.attempts);
    } catch (error) {
      fallbackReason = redactSensitiveText(formatErrorMessage(error));
      warnings.push(`整片理解失败：${fallbackReason}`);
    }

    if (!description && (probe.durationSeconds ?? 0) > MEDIUM_VIDEO_MAX_SECONDS) {
      if (!deps.ffmpegAvailable()) {
        needsFallback = true;
        fallbackReason = fallbackReason ?? "整片模型分析失败，且缺少 ffmpeg，无法切分长视频。";
      } else {
        fallbackReason =
          fallbackReason ?? "整片多模态模型未返回可用内容，已切换到120秒分段模型分析。";
        try {
          const segmented = await analyzeVideoSegments({
            filePath: acquired.path,
            workDir,
            durationSeconds: probe.durationSeconds!,
            prompt,
            cfg: params.cfg,
            agentDir: params.agentDir,
            deps,
            remainingMs,
          });
          modelAttempts.push(...segmented.attempts);
          description = segmented.description;
          route = "segmented-video";
          segmentation = {
            segmentSeconds: SEGMENT_SECONDS,
            overlapSeconds: SEGMENT_OVERLAP_SECONDS,
            concurrency: SEGMENT_CONCURRENCY,
            totalSegments: segmented.segments.length,
            analyzedSegments: segmented.analyzedSegments,
          };
          if (segmented.analyzedSegments < segmented.segments.length) {
            needsFallback = true;
            fallbackReason = `仅 ${segmented.analyzedSegments}/${segmented.segments.length} 个分段返回模型分析，继续执行音轨和关键帧兜底。`;
            warnings.push(fallbackReason);
          }
          if (segmented.analyzedSegments === 0) {
            route = "decomposed";
          }
        } catch (error) {
          needsFallback = true;
          fallbackReason = `视频分段或分段模型分析失败：${redactSensitiveText(formatErrorMessage(error))}`;
          warnings.push(fallbackReason);
        }
      }
    } else if (!description) {
      needsFallback = true;
      fallbackReason = fallbackReason ?? "整片多模态模型未返回可用内容。";
    }

    if (!description && route === "segmented-video") {
      needsFallback = true;
    }
    if (!description && route === "whole-video") {
      route = "decomposed";
    }

    if (needsFallback || route === "decomposed") {
      if (remainingMs() <= 0) {
        throw new ToolInputError("视频分析已达到30分钟总时限，请缩短视频后重试。");
      }
      if (!deps.ffmpegAvailable()) {
        throw new ToolInputError(
          "视频分析需要 ffmpeg（含 ffprobe），但没在可信目录里找到——出于防 PATH 劫持的考虑，OpenClaw 不读取 PATH。" +
            "请把 ffmpeg 装到系统目录（Windows：<Program Files>\\ffmpeg\\bin），" +
            "或设置环境变量 OPENCLAW_SYSTEM_BIN_DIRS 指向 ffmpeg 所在目录后重启网关。",
        );
      }
    }

    // Decomposition needs reliable duration and audio metadata. Never report
    // silence merely because probing failed during the multimodal attempt.
    if ((needsFallback || route === "decomposed") && probeFailed) {
      Object.assign(probe, await deps.probe(acquired.path, { timeoutMs: remainingMs() }));
    }

    const decomposed =
      needsFallback || route === "decomposed"
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
            remainingMs,
          })
        : {
            transcript: undefined,
            frames: [],
            snapshots: [],
            audio: {
              status: "not-requested",
              extraction: "not-attempted",
              message: `${route === "segmented-video" ? "使用分段多模态理解" : "使用整片多模态理解"}，未单独执行音轨提取和语音转写；不能据此确认口播转写完整性。`,
            } satisfies VideoAudioStatus,
          };

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
      audio: decomposed.audio,
      frames: decomposed.frames,
      snapshots: decomposed.snapshots,
      warnings,
      diagnostics: {
        strategy: route,
        totalLimitSeconds: 1800,
        elapsedMs: Math.max(0, deps.now() - startedAt),
        attempts: modelAttempts,
        fallbackReason,
        segmentation,
      },
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
      "Videos are analyzed by the multimodal model first. Clips over ten minutes are retried as overlapping two-minute model-analyzed segments; audio transcription and adaptive keyframes are the final fallback. " +
      "Check the returned audio status and warnings before claiming speech was analyzed; missing transcription does not prove silence. Frames are samples, not exhaustive coverage. " +
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
            `(session=${options?.agentSessionKey ?? "unknown"}, frames=${result.frames.length}, audio=${result.audio.status})`,
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
