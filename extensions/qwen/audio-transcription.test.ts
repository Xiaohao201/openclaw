import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.js";
import { transcribeQwenAudio } from "./audio-transcription.js";
import { buildQwenMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

const input = {
  buffer: Buffer.from("complete audio bytes"),
  fileName: "audio.wav",
  mime: "audio/wav",
  apiKey: "test-key",
  timeoutMs: 1000,
};

describe("Qwen ASR", () => {
  it("registers audio with a dedicated default model and discovery priority", () => {
    const provider = buildQwenMediaUnderstandingProvider();
    expect(provider.capabilities).toContain("audio");
    expect(provider.transcribeAudio).toBe(transcribeQwenAudio);
    expect(provider.defaultModels?.audio).toBe("qwen-audio-3.0-asr-flash");
    expect(provider.autoPriority?.audio).toBe(5);
  });

  it("sends every audio byte to the configured workspace and reads the full transcript", async () => {
    const capture = createRequestCaptureJsonFetch({
      output: { text: "complete transcript", sentence: { text: "last sentence only" } },
    });
    const result = await transcribeQwenAudio({
      ...input,
      baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com",
      language: "zh",
      fetchFn: capture.fetchFn,
    });
    const { url, init } = capture.getRequest();
    expect(url).toBe(
      "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    if (typeof init?.body !== "string") {
      throw new Error("Expected JSON request body");
    }
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen-audio-3.0-asr-flash");
    expect(body.input.messages[0].content).toEqual([
      {
        type: "input_audio",
        input_audio: { data: `data:audio/wav;base64,${input.buffer.toString("base64")}` },
      },
    ]);
    expect(body.parameters).toEqual({ format: "wav", language_hints: ["zh"] });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(new Headers(init?.headers).get("x-dashscope-sse")).toBe("disable");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ text: "complete transcript", model: body.model });
  });

  it.each([
    [undefined, "https://dashscope.aliyuncs.com"],
    ["https://coding.dashscope.aliyuncs.com/v1", "https://dashscope.aliyuncs.com"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com"],
    ["https://coding-intl.dashscope.aliyuncs.com/v1", "https://dashscope-intl.aliyuncs.com"],
    [
      "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      "https://workspace.cn-beijing.maas.aliyuncs.com",
    ],
  ])("normalizes the native endpoint %s", async (baseUrl, origin) => {
    const capture = createRequestCaptureJsonFetch({ output: { text: "transcript" } });
    await transcribeQwenAudio({ ...input, baseUrl, fetchFn: capture.fetchFn });
    expect(capture.getRequest().url).toBe(
      `${origin}/api/v1/services/aigc/multimodal-generation/generation`,
    );
  });

  it("accepts the MP3 audio extracted by video_understand", async () => {
    const capture = createRequestCaptureJsonFetch({ output: { text: "speech" } });
    await transcribeQwenAudio({
      ...input,
      mime: "audio/mpeg",
      fileName: "audio.mp3",
      fetchFn: capture.fetchFn,
    });
    const requestBody = capture.getRequest().init?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected JSON request body");
    }
    const body = JSON.parse(requestBody);
    expect(body.parameters.format).toBe("mp3");
    expect(body.input.messages[0].content[0].input_audio.data).toMatch(/^data:audio\/mpeg;base64,/);
  });

  it.each([
    {},
    { output: { text: " " } },
    { output: { sentence: { text: "last sentence" } } },
    { code: "InvalidApiKey", message: "echoed-secret" },
    { output: { text: 123 } },
  ])(
    "rejects incomplete or failed responses without returning fabricated speech",
    async (response) => {
      const capture = createRequestCaptureJsonFetch(response);
      await expect(transcribeQwenAudio({ ...input, fetchFn: capture.fetchFn })).rejects.toThrow(
        /Qwen ASR/,
      );
    },
  );

  it("rejects oversized inline audio before making a request", async () => {
    const capture = createRequestCaptureJsonFetch({ output: { text: "should not run" } });
    await expect(
      transcribeQwenAudio({ ...input, buffer: Buffer.alloc(7_500_001), fetchFn: capture.fetchFn }),
    ).rejects.toThrow(/10 MB/);
    expect(capture.getRequest().url).toBeNull();
  });

  it("does not expose echoed API keys in HTTP errors", async () => {
    const fetchFn = Object.assign(async () => new Response("echoed-secret", { status: 401 }), {
      preconnect: () => {},
    });
    await expect(transcribeQwenAudio({ ...input, fetchFn })).rejects.toThrow(
      "Qwen ASR request failed (HTTP 401)",
    );
  });

  it("aborts a stalled request at the configured timeout", async () => {
    const fetchFn = Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error("request aborted"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
        }),
      { preconnect: () => {} },
    );
    await expect(transcribeQwenAudio({ ...input, timeoutMs: 30, fetchFn })).rejects.toThrow(
      /abort/,
    );
  });

  it("uses the extension when MIME metadata is absent", async () => {
    const capture = createRequestCaptureJsonFetch({ output: { text: "speech" } });
    await expect(
      transcribeQwenAudio({ ...input, mime: undefined, fetchFn: capture.fetchFn }),
    ).resolves.toEqual({ text: "speech", model: "qwen-audio-3.0-asr-flash" });
  });

  it("rejects empty audio", async () => {
    await expect(transcribeQwenAudio({ ...input, buffer: Buffer.alloc(0) })).rejects.toThrow(
      /empty/,
    );
  });

  it.each([
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com?token=secret",
    "https://example.com#fragment",
  ])("rejects unsafe endpoint configuration %s", async (baseUrl) => {
    await expect(transcribeQwenAudio({ ...input, baseUrl })).rejects.toThrow(/HTTPS base URL/);
  });

  it("rejects unsupported formats before making a request", async () => {
    const capture = createRequestCaptureJsonFetch({});
    await expect(
      transcribeQwenAudio({
        ...input,
        mime: "text/plain",
        fileName: "text.txt",
        fetchFn: capture.fetchFn,
      }),
    ).rejects.toThrow(/format/);
    expect(capture.getRequest().url).toBeNull();
  });
});
