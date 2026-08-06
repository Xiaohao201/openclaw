import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { MediaUnderstandingOutput } from "../../media-understanding/types.js";
import { ToolInputError } from "./common.js";
import {
  createVideoUnderstandTool,
  type DescribeMediaParams,
  runVideoUnderstand,
  type VideoUnderstandToolDeps,
} from "./video-understand-tool.js";
import type { ExtractedFrame, VideoProbe } from "./video-understand.runtime.js";

const CFG = {} as OpenClawConfig;

type Recorder = {
  describeCalls: DescribeMediaParams[];
  acquired: string[];
  compressed: number;
  audioExtracted: number;
  framesRequested: number[];
};

function makeDeps(options?: {
  probe?: Partial<VideoProbe>;
  pageHtml?: string | null;
  describe?: (params: DescribeMediaParams) => Promise<MediaUnderstandingOutput[]>;
  ffmpegAvailable?: boolean;
  acquireError?: Error;
  frames?: ExtractedFrame[];
}): { deps: Partial<VideoUnderstandToolDeps>; recorder: Recorder } {
  const recorder: Recorder = {
    describeCalls: [],
    acquired: [],
    compressed: 0,
    audioExtracted: 0,
    framesRequested: [],
  };
  const deps: Partial<VideoUnderstandToolDeps> = {
    ffmpegAvailable: () => options?.ffmpegAvailable !== false,
    fetchPageHtml: async () => options?.pageHtml ?? null,
    acquire: async ({ url, workDir }) => {
      if (options?.acquireError) {
        throw options.acquireError;
      }
      recorder.acquired.push(url);
      return { path: `${workDir}/source.mp4`, via: "download", sourceUrl: url };
    },
    probe: async () => ({
      durationSeconds: 60,
      width: 1280,
      height: 720,
      hasAudio: true,
      sizeBytes: 1_000_000,
      ...options?.probe,
    }),
    compress: async ({ workDir }) => {
      recorder.compressed += 1;
      return `${workDir}/compressed.mp4`;
    },
    extractAudio: async ({ workDir }) => {
      recorder.audioExtracted += 1;
      return `${workDir}/audio.mp3`;
    },
    sampleFrames: async ({ maxFrames }) => {
      recorder.framesRequested.push(maxFrames);
      return (
        options?.frames ?? [
          { path: "/tmp/frame-01.jpg", atSeconds: 30 },
          { path: "/tmp/frame-02.jpg", atSeconds: 90 },
        ]
      );
    },
    describeMedia: async (params) => {
      recorder.describeCalls.push(params);
      if (options?.describe) {
        return options.describe(params);
      }
      if (params.capability === "video") {
        return [
          { kind: "video.description", attachmentIndex: 0, text: "整片描述", provider: "qwen" },
        ];
      }
      if (params.capability === "audio") {
        return [
          {
            kind: "audio.transcription",
            attachmentIndex: 0,
            text: "这是语音转写内容",
            provider: "google",
          },
        ];
      }
      return params.files.map((_file, index) => ({
        kind: "image.description" as const,
        attachmentIndex: index,
        text: `第 ${index + 1} 帧画面`,
        provider: "qwen",
      }));
    },
  };
  return { deps, recorder };
}

describe("runVideoUnderstand routing", () => {
  it("uses whole-video multimodal for a short clip", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 45 } });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/clip.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.route).toBe("whole-video");
    expect(result.description).toBe("整片描述");
    expect(result.transcript).toBeUndefined();
    expect(recorder.describeCalls.map((call) => call.capability)).toEqual(["video"]);
    expect(recorder.audioExtracted).toBe(0);
  });

  it("decomposes a long clip into transcript plus frame timeline", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 600 } });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/long.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.route).toBe("decomposed");
    expect(result.transcript).toBe("这是语音转写内容");
    expect(result.frames).toEqual([
      { at: "00:30", description: "第 1 帧画面" },
      { at: "01:30", description: "第 2 帧画面" },
    ]);
    expect(recorder.describeCalls.map((call) => call.capability)).toEqual(["audio", "image"]);
  });

  it("compresses before whole-video analysis when the file is oversized", async () => {
    const { deps, recorder } = makeDeps({
      probe: { durationSeconds: 100, sizeBytes: 200 * 1024 * 1024 },
    });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/big.mp4",
      cfg: CFG,
      deps,
    });
    expect(recorder.compressed).toBe(1);
    expect(result.route).toBe("whole-video");
  });

  it("falls back to the decomposed route when compression cannot hit the byte budget", async () => {
    const { deps, recorder } = makeDeps({
      probe: { durationSeconds: 100, sizeBytes: 200 * 1024 * 1024 },
    });
    deps.compress = async ({ workDir }) => {
      // Sparse file: reports an oversized length without writing 60MB to disk.
      const target = path.join(workDir, "compressed.mp4");
      const handle = await fs.open(target, "w");
      await handle.truncate(60 * 1024 * 1024);
      await handle.close();
      return target;
    };
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/big.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.route).toBe("decomposed");
    expect(result.warnings.join(" ")).toContain("体积上限");
    expect(recorder.describeCalls.map((call) => call.capability)).toEqual(["audio", "image"]);
  });

  it("falls back to the decomposed route when whole-video analysis returns nothing", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 30 },
      describe: async (params) => {
        if (params.capability === "video") {
          return [];
        }
        if (params.capability === "audio") {
          return [
            {
              kind: "audio.transcription",
              attachmentIndex: 0,
              text: "兜底转写",
              provider: "google",
            },
          ];
        }
        return [];
      },
    });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/clip.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.route).toBe("decomposed");
    expect(result.transcript).toBe("兜底转写");
  });

  it("falls back when whole-video analysis throws and records the reason", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 30 },
      describe: async (params) => {
        if (params.capability === "video") {
          throw new Error("provider exploded");
        }
        if (params.capability === "audio") {
          return [
            {
              kind: "audio.transcription",
              attachmentIndex: 0,
              text: "兜底转写",
              provider: "google",
            },
          ];
        }
        return [];
      },
    });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/clip.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.route).toBe("decomposed");
    expect(result.warnings.join(" ")).toContain("provider exploded");
  });

  it("notes a missing audio track instead of failing", async () => {
    const { deps, recorder } = makeDeps({
      probe: { durationSeconds: 600, hasAudio: false },
    });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/silent.mp4",
      cfg: CFG,
      deps,
    });
    expect(recorder.audioExtracted).toBe(0);
    expect(result.transcript).toBeUndefined();
    expect(result.frames).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("没有音轨");
  });

  it("keeps the frame timeline when transcription fails", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 600 },
      describe: async (params) => {
        if (params.capability === "audio") {
          throw new Error("no asr provider");
        }
        return params.files.map((_file, index) => ({
          kind: "image.description" as const,
          attachmentIndex: index,
          text: `帧 ${index + 1}`,
          provider: "qwen",
        }));
      },
    });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/long.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.frames).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("no asr provider");
  });

  it("throws when neither route produced any analysis", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 600 },
      describe: async () => [],
    });
    await expect(
      runVideoUnderstand({ url: "https://cdn.example.com/long.mp4", cfg: CFG, deps }),
    ).rejects.toThrow(/没有任何分析结果/);
  });
});

describe("runVideoUnderstand acquisition", () => {
  it("resolves the main video from an article URL", async () => {
    const { deps, recorder } = makeDeps({
      probe: { durationSeconds: 30 },
      pageHtml:
        '<html><head><meta property="og:video" content="https://cdn.example.com/main.mp4">' +
        "</head><body><article></article></body></html>",
    });
    const result = await runVideoUnderstand({
      url: "https://news.example.com/story.html",
      cfg: CFG,
      deps,
    });
    expect(recorder.acquired).toEqual(["https://cdn.example.com/main.mp4"]);
    expect(result.sourceUrl).toBe("https://news.example.com/story.html");
    expect(result.resolvedVideoUrl).toBe("https://cdn.example.com/main.mp4");
  });

  it("warns when the page had several plausible videos", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 30 },
      pageHtml:
        '<html><body><article class="article-content">' +
        '<video src="https://cdn.example.com/a.mp4" controls></video>' +
        '<video src="https://cdn.example.com/b.mp4" controls></video>' +
        "</article></body></html>",
    });
    const result = await runVideoUnderstand({
      url: "https://news.example.com/story.html",
      cfg: CFG,
      deps,
    });
    expect(result.warnings.join(" ")).toContain("多个视频");
  });

  it("rejects an article URL with no detectable video", async () => {
    const { deps } = makeDeps({
      pageHtml: "<html><body><article><p>纯文字</p></article></body></html>",
    });
    await expect(
      runVideoUnderstand({ url: "https://news.example.com/story.html", cfg: CFG, deps }),
    ).rejects.toThrow(ToolInputError);
  });

  it("skips page scanning for a direct media URL", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 30 } });
    await runVideoUnderstand({ url: "https://cdn.example.com/clip.mp4", cfg: CFG, deps });
    expect(recorder.acquired).toEqual(["https://cdn.example.com/clip.mp4"]);
  });

  it("skips page scanning for a platform watch page", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 30 } });
    await runVideoUnderstand({
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      cfg: CFG,
      deps,
    });
    expect(recorder.acquired).toEqual(["https://www.bilibili.com/video/BV1xx411c7mD"]);
  });

  it("rejects a clip longer than the hard duration cap", async () => {
    const { deps } = makeDeps({ probe: { durationSeconds: 7200 } });
    await expect(
      runVideoUnderstand({ url: "https://cdn.example.com/movie.mp4", cfg: CFG, deps }),
    ).rejects.toThrow(/超出上限/);
  });

  it("fails with an actionable message when ffmpeg is missing", async () => {
    const { deps } = makeDeps({ ffmpegAvailable: false });
    await expect(
      runVideoUnderstand({ url: "https://cdn.example.com/clip.mp4", cfg: CFG, deps }),
    ).rejects.toThrow(/ffmpeg/);
  });
});

describe("runVideoUnderstand output", () => {
  it("clamps the requested frame count", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 600 } });
    await runVideoUnderstand({
      url: "https://cdn.example.com/long.mp4",
      cfg: CFG,
      maxFrames: 999,
      deps,
    });
    expect(recorder.framesRequested).toEqual([24]);
  });

  it("raises the media output limits above the inbound-attachment defaults", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 600 } });
    await runVideoUnderstand({ url: "https://cdn.example.com/long.mp4", cfg: CFG, deps });
    const audioCall = recorder.describeCalls.find((call) => call.capability === "audio");
    expect(audioCall?.maxChars).toBeGreaterThan(500);
    const imageCall = recorder.describeCalls.find((call) => call.capability === "image");
    expect(imageCall?.maxAttachments).toBe(2);
  });

  it("passes a custom prompt through to the model", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 30 } });
    await runVideoUnderstand({
      url: "https://cdn.example.com/clip.mp4",
      cfg: CFG,
      prompt: "这段视频里有没有出现公司logo？",
      deps,
    });
    expect(recorder.describeCalls[0]?.prompt).toBe("这段视频里有没有出现公司logo？");
  });

  it("renders a markdown summary carrying source, transcript and timeline", async () => {
    const { deps } = makeDeps({ probe: { durationSeconds: 600 } });
    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/long.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.markdown).toContain("## 视频内容分析");
    expect(result.markdown).toContain("https://cdn.example.com/long.mp4");
    expect(result.markdown).toContain("### 语音转写");
    expect(result.markdown).toContain("这是语音转写内容");
    expect(result.markdown).toContain("**00:30**");
    expect(result.markdown).toContain("音轨转写 + 关键帧");
  });
});

describe("video_understand tool", () => {
  it("wraps the markdown as untrusted external content", async () => {
    const { deps } = makeDeps({ probe: { durationSeconds: 30 } });
    const tool = createVideoUnderstandTool({ config: CFG, deps });
    const result = await tool.execute?.("call-1", { url: "https://cdn.example.com/clip.mp4" });
    const payload = (result as { details: { markdown: string; route: string } }).details;
    expect(payload.route).toBe("whole-video");
    expect(payload.markdown).toContain("整片描述");
    expect(payload.markdown.toLowerCase()).toContain("untrusted");
  });

  it("requires a url", async () => {
    const tool = createVideoUnderstandTool({ config: CFG });
    await expect(tool.execute?.("call-2", {})).rejects.toThrow(ToolInputError);
  });
});
