import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSystemBin } from "../../infra/resolve-system-bin.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { runFfmpeg, runFfprobe } from "../../media/ffmpeg-exec.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveVideoPlatform } from "./web-video-detect.js";

/**
 * Acquisition and ffmpeg-side processing for the `video_understand` tool.
 *
 * Kept out of the tool module so the ffmpeg/yt-dlp probing stays lazily loaded:
 * a session that never analyzes a video should never shell out.
 */

const execFileAsync = promisify(execFile);

/** Beyond this the download is almost certainly a feature film, not a news clip. */
export const VIDEO_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const VIDEO_MAX_DURATION_SECONDS = 60 * 60;

/** Whole-video multimodal is only attempted below these thresholds. */
export const WHOLE_VIDEO_MAX_DURATION_SECONDS = 120;
export const WHOLE_VIDEO_TARGET_BYTES = 45 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const TRANSCODE_TIMEOUT_MS = 10 * 60_000;
const YTDLP_TIMEOUT_MS = 8 * 60_000;
const FFMPEG_STDOUT_MAX_BYTES = 4 * 1024 * 1024;

export type VideoProbe = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  sizeBytes: number;
};

export type AcquiredVideo = {
  path: string;
  /** How the file was obtained — surfaced in the tool result for debuggability. */
  via: "download" | "hls" | "yt-dlp";
  sourceUrl: string;
  platform?: string;
  title?: string;
};

export class VideoAcquisitionError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "VideoAcquisitionError";
  }
}

function ffmpegOptions(timeoutMs: number) {
  return { timeoutMs, maxBufferBytes: FFMPEG_STDOUT_MAX_BYTES };
}

export function hasYtDlp(): boolean {
  return Boolean(resolveSystemBin("yt-dlp", { trust: "standard" }));
}

export function hasFfmpeg(): boolean {
  return Boolean(resolveSystemBin("ffmpeg", { trust: "standard" }));
}

/** Probe container metadata; a missing duration is tolerated (some HLS remuxes omit it). */
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const stat = await fs.stat(filePath);
  const stdout = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { hasAudio: false, sizeBytes: stat.size };
  }
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const durationRaw = parsed.format?.duration ?? videoStream?.duration;
  const duration = durationRaw ? Number.parseFloat(durationRaw) : Number.NaN;
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    width: videoStream?.width,
    height: videoStream?.height,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    sizeBytes: stat.size,
  };
}

async function downloadDirect(params: {
  url: string;
  workDir: string;
  maxBytes: number;
}): Promise<string> {
  const fetched = await fetchRemoteMedia({
    url: params.url,
    maxBytes: params.maxBytes,
    readIdleTimeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  const extension = path.extname(fetched.fileName ?? "") || ".mp4";
  const target = path.join(params.workDir, `source${extension}`);
  await fs.writeFile(target, fetched.buffer);
  return target;
}

async function downloadHls(params: { url: string; workDir: string }): Promise<string> {
  const target = path.join(params.workDir, "source.mp4");
  await runFfmpeg(
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      params.url,
      "-t",
      String(VIDEO_MAX_DURATION_SECONDS),
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      target,
    ],
    ffmpegOptions(TRANSCODE_TIMEOUT_MS),
  );
  return target;
}

type YtDlpMetadata = { title?: string };

async function downloadWithYtDlp(params: {
  url: string;
  workDir: string;
}): Promise<{ path: string; title?: string }> {
  const binary = resolveSystemBin("yt-dlp", { trust: "standard" });
  if (!binary) {
    throw new VideoAcquisitionError(
      "该链接是平台视频页，需要 yt-dlp 才能取回视频。",
      "在部署机安装 yt-dlp（pip install -U yt-dlp）。装完若仍提示缺失，说明它不在可信目录里（OpenClaw 不读 PATH），" +
        "把它所在目录加到环境变量 OPENCLAW_SYSTEM_BIN_DIRS 后重启网关。",
    );
  }
  const outputTemplate = path.join(params.workDir, "source.%(ext)s");
  try {
    await execFileAsync(
      binary,
      [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        // Analysis only needs legible frames and clean audio; pulling 4K wastes
        // bandwidth and pushes the file past the transcode budget for nothing.
        "-S",
        "res:480,codec:h264",
        "-f",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--max-filesize",
        String(VIDEO_MAX_DOWNLOAD_BYTES),
        "-o",
        outputTemplate,
        params.url,
      ],
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: FFMPEG_STDOUT_MAX_BYTES },
    );
  } catch (error) {
    throw new VideoAcquisitionError(
      `yt-dlp 取回失败：${error instanceof Error ? error.message : String(error)}`,
      "平台可能需要登录 cookie，或该链接已失效。",
    );
  }

  const entries = await fs.readdir(params.workDir);
  const downloaded = entries.find((entry) => entry.startsWith("source."));
  if (!downloaded) {
    throw new VideoAcquisitionError("yt-dlp 未产出视频文件。");
  }

  let title: string | undefined;
  try {
    const { stdout } = await execFileAsync(
      binary,
      ["--no-playlist", "--no-warnings", "--skip-download", "--dump-single-json", params.url],
      { timeout: 60_000, maxBuffer: FFMPEG_STDOUT_MAX_BYTES },
    );
    const metadata = JSON.parse(stdout) as YtDlpMetadata;
    title = normalizeOptionalString(metadata.title);
  } catch {
    // Title is a nicety; a failed metadata pass must not fail the analysis.
  }

  return { path: path.join(params.workDir, downloaded), title };
}

/**
 * Fetch the video behind `url` into `workDir`, choosing the transport from the
 * URL shape: direct media file, HLS/DASH manifest, or a platform watch page.
 */
export async function acquireVideo(params: {
  url: string;
  workDir: string;
  maxBytes?: number;
}): Promise<AcquiredVideo> {
  const platform = resolveVideoPlatform(params.url);
  const maxBytes = params.maxBytes ?? VIDEO_MAX_DOWNLOAD_BYTES;
  const isManifest = /\.(?:m3u8|mpd)(?:$|[?#])/i.test(params.url);
  const isDirectFile = /\.(?:mp4|m4v|mov|webm|ogv|avi|flv|mkv)(?:$|[?#])/i.test(params.url);

  if (isManifest) {
    return {
      path: await downloadHls({ url: params.url, workDir: params.workDir }),
      via: "hls",
      sourceUrl: params.url,
      platform,
    };
  }
  if (isDirectFile) {
    return {
      path: await downloadDirect({ url: params.url, workDir: params.workDir, maxBytes }),
      via: "download",
      sourceUrl: params.url,
      platform,
    };
  }
  const viaYtDlp = await downloadWithYtDlp({ url: params.url, workDir: params.workDir });
  return {
    path: viaYtDlp.path,
    via: "yt-dlp",
    sourceUrl: params.url,
    platform,
    title: viaYtDlp.title,
  };
}

/**
 * Re-encode to a size a multimodal endpoint will accept. Resolution and bitrate
 * are chosen for legibility of on-screen text, not for viewing quality.
 */
export async function compressForWholeVideo(params: {
  inputPath: string;
  workDir: string;
  durationSeconds?: number;
  targetBytes?: number;
}): Promise<string> {
  const targetBytes = params.targetBytes ?? WHOLE_VIDEO_TARGET_BYTES;
  const duration = params.durationSeconds ?? WHOLE_VIDEO_MAX_DURATION_SECONDS;
  // Leave 15% headroom for container overhead and rate-control overshoot.
  const totalBitrate = Math.floor((targetBytes * 8 * 0.85) / Math.max(1, duration));
  const audioBitrate = 64_000;
  const videoBitrate = Math.max(200_000, totalBitrate - audioBitrate);
  const output = path.join(params.workDir, "compressed.mp4");
  await runFfmpeg(
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      params.inputPath,
      "-vf",
      "scale='min(640,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      String(videoBitrate),
      "-maxrate",
      String(videoBitrate),
      "-bufsize",
      String(videoBitrate * 2),
      "-c:a",
      "aac",
      "-b:a",
      String(audioBitrate),
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      output,
    ],
    ffmpegOptions(TRANSCODE_TIMEOUT_MS),
  );
  return output;
}

/** Extract a 16 kHz mono track — the format every ASR provider accepts without resampling. */
export async function extractAudioTrack(params: {
  inputPath: string;
  workDir: string;
}): Promise<string> {
  const output = path.join(params.workDir, "audio.mp3");
  await runFfmpeg(
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      params.inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      output,
    ],
    ffmpegOptions(TRANSCODE_TIMEOUT_MS),
  );
  return output;
}

export type ExtractedFrame = {
  path: string;
  /** Offset into the source video, used to label the visual timeline. */
  atSeconds: number;
};

function buildFrameTimestamps(durationSeconds: number, maxFrames: number): number[] {
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(durationSeconds / 5)));
  const step = durationSeconds / (count + 1);
  return Array.from({ length: count }, (_, index) => Math.round((index + 1) * step * 100) / 100);
}

/**
 * Sample frames across the clip.
 *
 * Seeking to explicit timestamps rather than using ffmpeg's scene filter keeps
 * the frame count deterministic and the timeline labeled — a scene filter on a
 * static talking-head video returns one frame, on a fast-cut clip hundreds.
 */
export async function extractFrames(params: {
  inputPath: string;
  workDir: string;
  durationSeconds: number;
  maxFrames: number;
}): Promise<ExtractedFrame[]> {
  const frameDir = path.join(params.workDir, "frames");
  await fs.mkdir(frameDir, { recursive: true });
  const timestamps = buildFrameTimestamps(params.durationSeconds, params.maxFrames);
  const frames: ExtractedFrame[] = [];
  for (const [index, atSeconds] of timestamps.entries()) {
    const output = path.join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    try {
      await runFfmpeg(
        [
          "-y",
          "-loglevel",
          "error",
          "-ss",
          String(atSeconds),
          "-i",
          params.inputPath,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(1280,iw)':-2",
          "-q:v",
          "3",
          output,
        ],
        ffmpegOptions(60_000),
      );
      const stat = await fs.stat(output).catch(() => null);
      if (stat?.isFile() && stat.size > 0) {
        frames.push({ path: output, atSeconds });
      }
    } catch {
      // A single unseekable timestamp should not sink the whole timeline.
    }
  }
  return frames;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
