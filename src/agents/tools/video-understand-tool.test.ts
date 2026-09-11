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
  savedFrames: string[];
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
    savedFrames: [],
  };
  const deps: Partial<VideoUnderstandToolDeps> = {
    ffmpegAvailable: () => options?.ffmpegAvailable !== false,
    fetchPageHtml: async () => options?.pageHtml ?? null,
    acquire: async ({ url, workDir }) => {
      if (options?.acquireError) {
        throw options.acquireError;
      }
      recorder.acquired.push(url);
      await fs.writeFile(path.join(workDir, "source.mp4"), "video");
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
    saveFrame: async ({ path: framePath }) => {
      recorder.savedFrames.push(framePath);
      return `/managed-media/${path.basename(framePath)}`;
    },
    describeMedia: async (params) => {
      recorder.describeCalls.push(params);
      if (options?.describe) {
        return options.describe(params);
      }
      if (params.capability === "video") {
        if ((options?.probe?.durationSeconds ?? 60) > 120) {
          return [];
        }
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

  it("tries long videos without ffmpeg and succeeds on the fifth retry", async () => {
    let attempts = 0;
    const { deps, recorder } = makeDeps({
      ffmpegAvailable: false,
      probe: { durationSeconds: 600 },
      describe: async () => {
        attempts += 1;
        if (attempts < 6) {
          throw new Error("temporary provider failure");
        }
        return [
          { kind: "video.description", attachmentIndex: 0, text: "success", provider: "qwen" },
        ];
      },
    });
    deps.probe = async () => {
      throw new Error("ffprobe missing");
    };
    const result = await runVideoUnderstand({
      url: "https://example.com/video.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.route).toBe("whole-video");
    expect(attempts).toBe(6);
    expect(recorder.audioExtracted).toBe(0);
    expect(recorder.framesRequested).toEqual([]);
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
    expect(recorder.describeCalls.map((call) => call.capability)).toEqual([
      ...Array<string>(6).fill("video"),
      "audio",
      "image",
    ]);
  });

  it("starts audio transcription and frame understanding in parallel", async () => {
    const started = new Set<string>();
    let releaseAudio: (() => void) | undefined;
    let releaseImage: (() => void) | undefined;
    const audioGate = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    const { deps } = makeDeps({
      probe: { durationSeconds: 600 },
      describe: async (params) => {
        started.add(params.capability);
        if (params.capability === "audio") {
          await audioGate;
          return [
            {
              kind: "audio.transcription",
              attachmentIndex: 0,
              text: "并行转写",
              provider: "google",
            },
          ];
        }
        if (params.capability === "image") {
          await imageGate;
          return [
            {
              kind: "image.description",
              attachmentIndex: 0,
              text: "并行画面",
              provider: "qwen",
            },
          ];
        }
        return [];
      },
    });

    const pending = runVideoUnderstand({
      url: "https://cdn.example.com/long.mp4",
      cfg: CFG,
      deps,
    });

    await expect
      .poll(() => [...started].filter((capability) => capability !== "video").toSorted())
      .toEqual(["audio", "image"]);
    releaseAudio?.();
    releaseImage?.();
    await expect(pending).resolves.toMatchObject({
      transcript: "并行转写",
      frames: [{ at: "00:30", description: "并行画面" }],
    });
  });

  it.each([46 * 1024 ** 2, 512 * 1024 ** 2, 2 * 1024 ** 3])(
    "does not compress %i bytes",
    async (sizeBytes) => {
      const { deps, recorder } = makeDeps({ probe: { sizeBytes } });
      const result = await runVideoUnderstand({
        url: "https://cdn.example.com/large.mp4",
        cfg: CFG,
        deps,
      });
      expect(result.route).toBe("whole-video");
      expect(recorder.compressed).toBe(0);
      expect(recorder.describeCalls[0]?.files[0]?.url).toBe("https://cdn.example.com/large.mp4");
    },
  );

  it("compresses before whole-video analysis when the file is oversized", async () => {
    const { deps, recorder } = makeDeps({
      probe: { durationSeconds: 100, sizeBytes: 2 * 1024 ** 3 + 1 },
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
      probe: { durationSeconds: 100, sizeBytes: 2 * 1024 ** 3 + 1 },
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
    expect(result.warnings.join(" ")).toContain("tools.media.video");
    expect(result.warnings.join(" ")).toContain("QWEN_API_KEY");
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
        if (params.capability === "video") {
          return [];
        }
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

  it("returns saved keyframes when no provider produced text", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 600, hasAudio: false },
      describe: async () => [],
    });

    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/silent.mp4",
      cfg: CFG,
      deps,
    });

    expect(result.frames).toEqual([]);
    expect(result.snapshots).toHaveLength(2);
    expect(result.markdown).toContain("### 关键帧截图");
  });

  it("throws when neither route produced any analysis", async () => {
    const { deps } = makeDeps({
      probe: { durationSeconds: 600 },
      describe: async () => [],
      frames: [],
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
    const { deps } = makeDeps({ ffmpegAvailable: false, describe: async () => [] });
    await expect(
      runVideoUnderstand({ url: "https://cdn.example.com/clip.mp4", cfg: CFG, deps }),
    ).rejects.toThrow(/ffmpeg/);
  });
});

describe("runVideoUnderstand output", () => {
  it("uses an adaptive six-frame default budget", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 80 } });
    deps.describeMedia = async (params) => {
      recorder.describeCalls.push(params);
      if (params.capability === "video" || params.capability === "image") {
        return [];
      }
      return [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "转写内容",
          provider: "google",
        },
      ];
    };

    const result = await runVideoUnderstand({
      url: "https://cdn.example.com/eighty-seconds.mp4",
      cfg: CFG,
      deps,
    });

    expect(recorder.framesRequested).toEqual([6]);
    expect(recorder.savedFrames).toEqual(["/tmp/frame-01.jpg", "/tmp/frame-02.jpg"]);
    expect(result.snapshots).toEqual([
      { at: "00:30", path: "/managed-media/frame-01.jpg" },
      { at: "01:30", path: "/managed-media/frame-02.jpg" },
    ]);
    expect(result.markdown).toContain("MEDIA:/managed-media/frame-01.jpg");
    expect(result.warnings.join(" ")).toContain("tools.media.image");
    expect(result.warnings.join(" ")).toContain("QWEN_API_KEY");
  });

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
  it.each(["disabled", "scope-deny", "no-attachment"] as const)(
    "preserves runner skip reason %s",
    async (outcome) => {
      const { deps } = makeDeps({ probe: { durationSeconds: 600 } });
      const original = deps.describeMedia!;
      deps.describeMedia = async (params) => {
        if (params.capability !== "audio") {
          return original(params);
        }
        params.onDecision?.({ capability: "audio", outcome, attachments: [] });
        return [];
      };
      const result = await runVideoUnderstand({
        url: "https://example.com/video.mp4",
        cfg: CFG,
        deps,
      });
      expect(result.audio.status).toBe("skipped");
      expect(result.audio.decision?.outcome).toBe(outcome);
      expect(result.markdown).toContain(outcome);
    },
  );

  it.each([false, true])("redacts provider errors and preserves recovery: %s", async (recover) => {
    const secret = "sk-examplefakecredential123456789";
    const { deps } = makeDeps({ probe: { durationSeconds: 600 } });
    const original = deps.describeMedia!;
    deps.describeMedia = async (params) => {
      if (params.capability !== "audio") {
        return original(params);
      }
      params.onDecision?.({
        capability: "audio",
        outcome: recover ? "success" : "failed",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "example",
                model: "asr",
                outcome: "failed",
                reason: `HTTP 401 Authorization: Bearer ${secret}`,
              },
            ],
          },
        ],
      });
      if (!recover) {
        throw new Error(`HTTP 401 Authorization: Bearer ${secret}`);
      }
      return original(params);
    };
    const result = await runVideoUnderstand({
      url: "https://example.com/video.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.audio.status).toBe(recover ? "success" : "transcription-failed");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.audio.decision?.attachments[0]?.attempts[0]?.reason).toContain("HTTP 401");
  });

  it.each(["failed", "skipped", "success"] as const)(
    "reports audio runner outcome %s without claiming silence",
    async (outcome) => {
      const { deps } = makeDeps({
        probe: { durationSeconds: 600 },
        describe: async (params) => {
          if (params.capability === "video") {
            return [];
          }
          if (params.capability === "audio") {
            params.onDecision?.({
              capability: "audio",
              outcome,
              attachments: [
                {
                  attachmentIndex: 0,
                  attempts:
                    outcome === "skipped"
                      ? []
                      : [
                          {
                            type: "provider",
                            provider: "example",
                            outcome,
                            reason: "transcription service unavailable",
                          },
                        ],
                },
              ],
            });
            return [];
          }
          return [
            {
              kind: "image.description",
              attachmentIndex: 0,
              text: "画面字幕",
              provider: "example",
            },
          ];
        },
      });
      const result = await runVideoUnderstand({
        url: "https://example.com/video.mp4",
        cfg: CFG,
        deps,
      });
      expect(result.audio.status).toBe(
        outcome === "failed"
          ? "transcription-failed"
          : outcome === "skipped"
            ? "unavailable"
            : "empty",
      );
      expect(result.audio.extraction).toBe("success");
      expect(result.audio.decision?.outcome).toBe(outcome);
      expect(result.markdown).toContain("不能据此判断视频没有人声");
      expect(result.markdown).not.toContain("分析方式：音轨转写 + 关键帧");
      expect(result.markdown).toContain("抽样关键帧");
    },
  );

  it("distinguishes extraction failure from transcription failure", async () => {
    const { deps, recorder } = makeDeps({ probe: { durationSeconds: 600 } });
    deps.extractAudio = async () => {
      throw new Error("ffmpeg failed");
    };
    const result = await runVideoUnderstand({
      url: "https://example.com/video.mp4",
      cfg: CFG,
      deps,
    });
    expect(result.audio).toMatchObject({ status: "extraction-failed", extraction: "failed" });
    expect(recorder.describeCalls.some((call) => call.capability === "audio")).toBe(false);
  });

  it("reports absent audio and successful transcription separately", async () => {
    for (const hasAudio of [false, true]) {
      const { deps, recorder } = makeDeps({ probe: { durationSeconds: 600, hasAudio } });
      const result = await runVideoUnderstand({
        url: "https://example.com/video.mp4",
        cfg: CFG,
        deps,
      });
      expect(result.audio.status).toBe(hasAudio ? "success" : "no-audio");
      expect(recorder.audioExtracted).toBe(hasAudio ? 1 : 0);
    }
  });

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
