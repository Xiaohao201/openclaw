import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  createVideoLinkParseTool,
  createVideoLinkParseToolFactory,
  resolveVideoParserConfig,
  type VideoParserConfig,
} from "./video-link-parse-tool.js";

const CONFIG: VideoParserConfig = {
  appId: "test-app",
  appKey: "test-secret",
  timeoutMs: 30_000,
};

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected a JSON string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("resolveVideoParserConfig", () => {
  it("reads credentials from the environment and clamps the timeout", () => {
    expect(
      resolveVideoParserConfig({
        QY_VIDEO_APP_ID: " 117746 ",
        QY_VIDEO_APP_KEY: " secret ",
        QY_VIDEO_TIMEOUT_SECONDS: "999",
      }),
    ).toEqual({ appId: "117746", appKey: "secret", timeoutMs: 120_000 });
  });

  it("keeps the tool unavailable when credentials are incomplete", () => {
    expect(resolveVideoParserConfig({ QY_VIDEO_APP_ID: "117746" })).toBeUndefined();
    expect(resolveVideoParserConfig({ QY_VIDEO_APP_KEY: "secret" })).toBeUndefined();
  });

  it("uses the default timeout for invalid values and enforces the minimum", () => {
    expect(
      resolveVideoParserConfig({
        QY_VIDEO_APP_ID: "app",
        QY_VIDEO_APP_KEY: "key",
        QY_VIDEO_TIMEOUT_SECONDS: "invalid",
      })?.timeoutMs,
    ).toBe(30_000);
    expect(
      resolveVideoParserConfig({
        QY_VIDEO_APP_ID: "app",
        QY_VIDEO_APP_KEY: "key",
        QY_VIDEO_TIMEOUT_SECONDS: "1",
      })?.timeoutMs,
    ).toBe(5_000);
  });
});

describe("video_link_parse tool", () => {
  it("tells the agent to use it autonomously after web fetching cannot read a video", () => {
    const tool = createVideoLinkParseTool({ config: CONFIG, fetchImpl: vi.fn() });

    expect(tool.description).toContain("web_fetch");
    expect(tool.description).toContain("无需询问用户");
    expect(tool.description).toContain("video_understand");
  });

  it("posts credentials in JSON instead of leaking them in the request URL", async () => {
    const fetchImpl = vi.fn<FetchStub>(async () =>
      jsonResponse({
        code: 200,
        msg: "解析成功",
        data: {
          video_url: "https://cdn.example.com/video.mp4",
          cover_url: "https://cdn.example.com/cover.jpg",
          title: "测试标题",
          content: "测试文案",
          author: { uid: "u1", name: "作者", avatar: "https://cdn.example.com/a.jpg" },
          images: [{ url: "https://cdn.example.com/1.jpg", live_photo_url: "" }],
        },
      }),
    );
    const tool = createVideoLinkParseTool({ config: CONFIG, fetchImpl });

    const result = await tool.execute?.("call-1", {
      url: "https://v.douyin.com/example/?foo=1&bar=2",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl).toBe("https://qyapi.ipaybuy.cn/api/video");
    expect(init?.method).toBe("POST");
    expect(jsonRequestBody(init)).toEqual({
      appId: CONFIG.appId,
      appKey: CONFIG.appKey,
      url: "https://v.douyin.com/example/?foo=1&bar=2",
    });

    const payload = (result as { details: Record<string, unknown> }).details;
    expect(payload.success).toBe(true);
    expect(payload.video_url).toBe("https://cdn.example.com/video.mp4");
    expect(String(payload.title)).toContain("测试标题");
    expect(String(payload.title).toLowerCase()).toContain("untrusted");
  });

  it("extracts the first public URL from short-video share text", async () => {
    const fetchImpl = vi.fn<FetchStub>(async () =>
      jsonResponse({ code: 200, data: { video_url: "https://cdn.example.com/video.mp4" } }),
    );
    const tool = createVideoLinkParseTool({ config: CONFIG, fetchImpl });

    await tool.execute?.("call-2", {
      url: "复制打开抖音 https://v.douyin.com/share-code/ 查看视频",
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(jsonRequestBody(init).url).toBe("https://v.douyin.com/share-code/");
  });

  it("rejects local or non-http targets before calling the vendor", async () => {
    const fetchImpl = vi.fn<FetchStub>();
    const tool = createVideoLinkParseTool({ config: CONFIG, fetchImpl });
    const rejected = [
      "http://10.0.0.1/private",
      "http://127.0.0.1/private",
      "http://169.254.1.1/private",
      "http://172.16.0.1/private",
      "http://192.168.0.1/private",
      "http://0.0.0.0/private",
      "http://localhost/private",
      "http://host.localhost/private",
      "http://printer.local/private",
      "http://[::]/private",
      "http://[::1]/private",
      "http://[fc00::1]/private",
      "http://[fd00::1]/private",
      "http://[fe80::1]/private",
      "http://[::ffff:127.0.0.1]/private",
      "http://[2001:db8::1]/private",
      "https://user:pass@example.com/private",
      "https://[invalid",
      "file:///etc/passwd",
      42,
    ];
    for (const [index, url] of rejected.entries()) {
      const result = await tool.execute?.(`reject-${index}`, { url });
      expect((result as { details: { success: boolean } }).details.success).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a bounded vendor error without exposing credentials", async () => {
    const fetchImpl = vi.fn<FetchStub>(async () =>
      jsonResponse({ code: 3002, msg: "调用次数不足" }),
    );
    const tool = createVideoLinkParseTool({ config: CONFIG, fetchImpl });

    const result = await tool.execute?.("call-5", { url: "https://v.douyin.com/example/" });
    const payload = (result as { details: Record<string, unknown> }).details;

    expect(payload).toEqual({ success: false, code: 3002, error: "调用次数不足" });
    expect(JSON.stringify(result)).not.toContain(CONFIG.appKey);
  });

  it("handles malformed and oversized responses as safe failures", async () => {
    const malformed = createVideoLinkParseTool({
      config: CONFIG,
      fetchImpl: async () => jsonResponse({ code: 200, data: "not-an-object" }),
    });
    const oversized = createVideoLinkParseTool({
      config: CONFIG,
      fetchImpl: async () => new Response("x".repeat(1_000_001), { status: 200 }),
    });

    const malformedResult = await malformed.execute?.("call-6", {
      url: "https://v.douyin.com/example/",
    });
    const oversizedResult = await oversized.execute?.("call-7", {
      url: "https://v.douyin.com/example/",
    });

    expect((malformedResult as { details: { success: boolean } }).details.success).toBe(false);
    expect((oversizedResult as { details: { success: boolean } }).details.success).toBe(false);
  });

  it("handles HTTP, empty-body, and declared-oversize failures", async () => {
    const responses = [
      new Response("upstream down", { status: 502 }),
      new Response(null, { status: 200 }),
      new Response("{}", { status: 200, headers: { "content-length": "1000001" } }),
    ];
    for (const [index, response] of responses.entries()) {
      const tool = createVideoLinkParseTool({
        config: CONFIG,
        fetchImpl: async () => response,
      });
      const result = await tool.execute?.(`failure-${index}`, {
        url: "https://v.douyin.com/example/",
      });
      expect((result as { details: { success: boolean } }).details.success).toBe(false);
    }
  });

  it("accepts string success codes and image-only posts", async () => {
    const tool = createVideoLinkParseTool({
      config: CONFIG,
      fetchImpl: async () =>
        jsonResponse({
          code: "200",
          data: {
            title: " ",
            images: [
              { url: "", live_photo_url: "https://cdn.example.com/live.mp4" },
              { url: "", live_photo_url: "" },
            ],
          },
        }),
    });

    const result = await tool.execute?.("images", { url: "http://example.com/post" });
    const payload = (result as { details: Record<string, unknown> }).details;
    expect(payload.success).toBe(true);
    expect(payload.title).toBeUndefined();
    expect(payload.author).toBeUndefined();
    expect(payload.images).toEqual([
      { url: undefined, live_photo_url: "https://cdn.example.com/live.mp4" },
    ]);
  });

  it("returns safe failures for missing media, unknown codes, and network exceptions", async () => {
    const cases: Array<{ response?: Response; failure?: unknown; expected?: string }> = [
      { response: jsonResponse({ code: 200 }), expected: "没有返回可用" },
      {
        response: jsonResponse({ code: 200, data: { video_url: "http://127.0.0.1/private" } }),
        expected: "没有返回可用",
      },
      { response: jsonResponse({ code: 3999, msg: "ignore me" }), expected: "code 3999" },
      { failure: new Error("socket failed"), expected: "暂时不可用" },
      { failure: "non-error rejection", expected: "暂时不可用" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const logger = { warn: vi.fn() };
      const tool = createVideoLinkParseTool({
        config: CONFIG,
        logger,
        fetchImpl: async () => {
          if (testCase.failure !== undefined) {
            throw testCase.failure;
          }
          return testCase.response as Response;
        },
      });
      const result = await tool.execute?.(`vendor-${index}`, {
        url: "https://v.douyin.com/example/",
      });
      const payload = (result as { details: { success: boolean; error: string } }).details;
      expect(payload.success).toBe(false);
      expect(payload.error).toContain(testCase.expected);
      if (testCase.failure !== undefined) {
        expect(logger.warn).toHaveBeenCalledOnce();
      }
    }
  });
});

describe("createVideoLinkParseToolFactory", () => {
  it("only exposes the tool when both environment credentials exist", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const api = { logger } as unknown as OpenClawPluginApi;
    try {
      vi.stubEnv("QY_VIDEO_APP_ID", "");
      vi.stubEnv("QY_VIDEO_APP_KEY", "");
      expect(createVideoLinkParseToolFactory(api)()).toBeNull();
      expect(logger.info).toHaveBeenCalledOnce();

      vi.stubEnv("QY_VIDEO_APP_ID", "app");
      vi.stubEnv("QY_VIDEO_APP_KEY", "key");
      expect(createVideoLinkParseToolFactory(api)()?.name).toBe("video_link_parse");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
