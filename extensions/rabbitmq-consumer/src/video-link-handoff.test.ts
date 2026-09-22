import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { createVideoLinkHandoff } from "./video-link-handoff.js";
import { createVideoLinkParseToolFactory } from "./video-link-parse-tool.js";

const sourceUrl = "https://www.douyin.com/share/video/123";
const videoUrl = "https://cdn.example.com/video/123?sign=a%2Fb&mime_type=video_mp4";
const session = { agentId: "suheng", sessionKey: "chat:user-a", sessionId: "session-a" };

function setup() {
  vi.stubEnv("QY_VIDEO_APP_ID", "test-app");
  vi.stubEnv("QY_VIDEO_APP_KEY", "test-key");
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const api = { on, logger: { info: vi.fn(), warn: vi.fn() } } as unknown as OpenClawPluginApi;
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ code: 200, data: { video_url: videoUrl } })),
    );
  vi.stubGlobal("fetch", fetch);
  const factory = createVideoLinkParseToolFactory(api);
  const registration = on.mock.calls.find(([name]) => name === "before_tool_call");
  if (!registration) {
    throw new Error("Expected video handoff hook registration");
  }
  // Narrow the generic registration to the concrete hook contract used here.
  const before = registration[1] as (
    event: { toolName: string; params: Record<string, unknown> },
    context: typeof session & { toolName: string },
  ) => { params?: Record<string, unknown> } | undefined;
  return {
    fetch,
    parse: (url = sourceUrl, context = session) => factory(context)!.execute("parse", { url }),
    rewrite: (url = sourceUrl, context = session, toolName = "video_understand") =>
      before(
        { toolName, params: { url, prompt: "Analyze", timeout: 123 } },
        { ...context, toolName },
      ),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("hands a successful parse to video understanding even when the model reuses the page URL", async () => {
  const test = setup();
  await test.parse();
  expect(test.rewrite()).toEqual({ params: { url: videoUrl, prompt: "Analyze", timeout: 123 } });
  expect(test.rewrite(videoUrl)).toBeUndefined();
  expect(test.rewrite("https://www.douyin.com/share/video/456")).toBeUndefined();
  expect(test.rewrite(sourceUrl, session, "web_fetch")).toBeUndefined();
});

it("isolates sessions, agents, resets, and plugin registrations", async () => {
  const test = setup();
  await test.parse();
  expect(test.rewrite(sourceUrl, { ...session, sessionKey: "chat:user-b" })).toBeUndefined();
  expect(test.rewrite(sourceUrl, { ...session, agentId: "other" })).toBeUndefined();
  expect(test.rewrite(sourceUrl, { ...session, sessionId: "reset-session" })).toBeUndefined();
  expect(setup().rewrite()).toBeUndefined();
});

it("expires signed links after five minutes", async () => {
  vi.useFakeTimers();
  const test = setup();
  await test.parse();
  vi.advanceTimersByTime(5 * 60_000);
  expect(test.rewrite()).toBeUndefined();
});

it("invalidates earlier results when parsing the same source fails", async () => {
  const test = setup();
  await test.parse();
  test.fetch.mockImplementation(async () => new Response("{}", { status: 503 }));
  await test.parse();
  expect(test.rewrite()).toBeUndefined();
});

it("recognizes both original and expanded WeChat share URLs", async () => {
  const test = setup();
  await test.parse("https://weixin.qq.com/sph/example");
  expect(test.rewrite("https://weixin.qq.com/sph/example")?.params?.url).toBe(videoUrl);
  expect(
    test.rewrite("https://channels.weixin.qq.com/finder-preview/pages/sph?id=example")?.params?.url,
  ).toBe(videoUrl);
});

it("does not retain mappings without a trusted session identity", () => {
  const handoff = createVideoLinkHandoff();
  const target = { sourceUrl, resolvedUrl: sourceUrl, videoUrl };
  for (const context of [{}, { sessionKey: "a" }, { sessionId: "a" }]) {
    handoff.record(context, target);
    expect(handoff.resolve(context, sourceUrl)).toBeUndefined();
  }
});

it("bounds retained mappings and replaces an old signed link with the latest parse", () => {
  const handoff = createVideoLinkHandoff();
  for (let index = 0; index < 257; index++) {
    const url = `${sourceUrl}/${index}`;
    handoff.record(session, { sourceUrl: url, resolvedUrl: url, videoUrl });
  }
  expect(handoff.resolve(session, `${sourceUrl}/0`)).toBeUndefined();
  expect(handoff.resolve(session, `${sourceUrl}/256`)).toBe(videoUrl);
  handoff.record(session, { sourceUrl, resolvedUrl: sourceUrl, videoUrl });
  handoff.record(session, { sourceUrl, resolvedUrl: sourceUrl, videoUrl: `${videoUrl}&fresh=1` });
  expect(handoff.resolve(session, sourceUrl)).toBe(`${videoUrl}&fresh=1`);
  expect(handoff.resolve(session, undefined)).toBeUndefined();
});

it.each([
  { code: 200, data: { images: [{ url: "https://cdn.example.com/cover.jpg" }] } },
  { code: 200, data: { video_url: "http://127.0.0.1/private" } },
])("does not reuse an old video for image-only or invalid parse results", async (payload) => {
  const test = setup();
  await test.parse();
  test.fetch.mockImplementation(async () => new Response(JSON.stringify(payload)));
  await test.parse();
  expect(test.rewrite()).toBeUndefined();
});
