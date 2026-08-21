import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.js";
import {
  buildQwenMediaUnderstandingProvider,
  describeQwenImagesWithApiKey,
  describeQwenVideo,
} from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("describeQwenVideo", () => {
  it("opts image and video understanding into key-based auto-discovery", () => {
    const provider = buildQwenMediaUnderstandingProvider();

    expect(provider.autoPriority).toEqual({ image: 35, video: 15 });
  });

  it("builds the expected OpenAI-compatible video payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [
        {
          message: {
            content: [{ text: " first " }, { text: "second" }],
          },
        },
      ],
    });

    const result = await describeQwenVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      mime: "video/mp4",
      apiKey: "test-key",
      timeoutMs: 1500,
      baseUrl: "https://example.com/v1",
      model: "qwen-vl-max",
      prompt: "summarize the clip",
      headers: { "X-Other": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.model).toBe("qwen-vl-max");
    expect(result.text).toBe("first\nsecond");
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : Buffer.isBuffer(init?.body)
          ? init.body.toString("utf8")
          : "";
    const body = JSON.parse(bodyText);
    expect(body.model).toBe("qwen-vl-max");
    expect(body.messages?.[0]?.content?.[0]?.text).toBe("summarize the clip");
    expect(body.messages?.[0]?.content?.[1]?.type).toBe("video_url");
    expect(body.messages?.[0]?.content?.[1]?.video_url?.url).toBe(
      `data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}`,
    );
  });

  it("maps a Coding Plan host to the Standard endpoint", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "video result" } }],
    });

    await describeQwenVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      mime: "video/mp4",
      apiKey: "test-key",
      timeoutMs: 1500,
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      fetchFn,
    });

    expect(getRequest().url).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });
});

describe("describeQwenImagesWithApiKey", () => {
  it("sends images directly to qwen-vl on the Standard endpoint", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "frame result" } }],
    });

    const result = await describeQwenImagesWithApiKey({
      images: [
        { buffer: Buffer.from("first-image"), fileName: "first.jpg", mime: "image/jpeg" },
        { buffer: Buffer.from("second-image"), fileName: "second.png", mime: "image/png" },
      ],
      apiKey: "test-key",
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      timeoutMs: 1500,
      prompt: "describe both frames",
      fetchFn,
    });
    const { url, init } = getRequest();
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : Buffer.isBuffer(init?.body)
          ? init.body.toString("utf8")
          : "";
    const body = JSON.parse(bodyText);

    expect(result).toEqual({ text: "frame result", model: "qwen-vl-max-latest" });
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "describe both frames" });
    expect(body.messages[0].content[1].image_url.url).toBe(
      `data:image/jpeg;base64,${Buffer.from("first-image").toString("base64")}`,
    );
    expect(body.messages[0].content[2].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("second-image").toString("base64")}`,
    );
  });
});
