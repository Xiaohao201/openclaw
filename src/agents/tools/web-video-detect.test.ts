import { describe, expect, it } from "vitest";
import {
  detectVideoCandidates,
  parseIsoDurationSeconds,
  resolveVideoPlatform,
  summarizeVideoDetection,
} from "./web-video-detect.js";

const PAGE_URL = "https://news.example.com/2026/08/story.html";

function page(body: string, head = ""): string {
  return `<!doctype html><html><head><title>示例新闻标题</title>${head}</head><body>${body}</body></html>`;
}

describe("detectVideoCandidates", () => {
  it("returns nothing for a page without video", async () => {
    const result = await detectVideoCandidates({
      html: page("<article><p>纯文字报道</p></article>"),
      url: PAGE_URL,
    });
    expect(result.main).toBeUndefined();
    expect(result.others).toEqual([]);
    expect(summarizeVideoDetection(result)).toBeUndefined();
  });

  it("prefers the og:video declaration over an in-page <video>", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<article><video src="https://cdn.example.com/inline.mp4" controls></video></article>',
        '<meta property="og:video:secure_url" content="https://cdn.example.com/main.mp4">',
      ),
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://cdn.example.com/main.mp4");
    expect(result.main?.source).toBe("og");
    expect(result.main?.kind).toBe("file");
    expect(result.others.map((item) => item.url)).toContain("https://cdn.example.com/inline.mp4");
  });

  it("excludes videos inside recommendation and ad containers", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<article class="article-content"><video src="https://cdn.example.com/story.mp4" controls></video></article>' +
          '<div class="recommend-list"><video src="https://cdn.example.com/promoted.mp4" controls></video></div>' +
          '<aside><video src="https://cdn.example.com/sidebar.mp4" controls></video></aside>',
      ),
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://cdn.example.com/story.mp4");
    const urls = [result.main, ...result.others].map((item) => item?.url);
    expect(urls).not.toContain("https://cdn.example.com/promoted.mp4");
    expect(urls).not.toContain("https://cdn.example.com/sidebar.mp4");
  });

  it("demotes decorative autoplay background loops", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<div class="hero"><video src="https://cdn.example.com/bg.mp4" autoplay muted loop></video></div>' +
          '<article><video src="https://cdn.example.com/report.mp4" controls></video></article>',
      ),
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://cdn.example.com/report.mp4");
  });

  it("reads title, duration and poster from JSON-LD VideoObject", async () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: "示例新闻标题",
      duration: "PT2M14S",
      contentUrl: "https://cdn.example.com/ld.mp4",
      thumbnailUrl: "https://cdn.example.com/poster.jpg",
    });
    const result = await detectVideoCandidates({
      html: page("<article></article>", `<script type="application/ld+json">${jsonLd}</script>`),
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://cdn.example.com/ld.mp4");
    expect(result.main?.title).toBe("示例新闻标题");
    expect(result.main?.durationSeconds).toBe(134);
    expect(result.main?.poster).toBe("https://cdn.example.com/poster.jpg");
  });

  it("resolves relative sources against the page URL", async () => {
    const result = await detectVideoCandidates({
      html: page('<article><video src="/media/clip.mp4" controls></video></article>'),
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://news.example.com/media/clip.mp4");
  });

  it("classifies HLS manifests found in inline player scripts", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<script>var player={src:"https:\\/\\/cdn.example.com\\/live\\/stream.m3u8?token=a"};</script>',
      ),
      url: PAGE_URL,
    });
    expect(result.main?.kind).toBe("hls");
    expect(result.main?.url).toBe("https://cdn.example.com/live/stream.m3u8?token=a");
  });

  it("treats a platform watch page as the video when markup is client-rendered", async () => {
    const result = await detectVideoCandidates({
      html: page("<div id=app></div>"),
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
    });
    expect(result.main?.source).toBe("page-url");
    expect(result.main?.kind).toBe("platform");
    expect(result.main?.platform).toBe("哔哩哔哩");
  });

  it("keeps an embedded platform player found inside the article", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<article><iframe src="https://player.bilibili.com/player.html?bvid=BV1xx"></iframe></article>',
      ),
      url: PAGE_URL,
    });
    expect(result.main?.platform).toBe("哔哩哔哩");
    expect(result.main?.source).toBe("iframe");
  });

  it("flags ambiguity when two candidates score within the tie margin", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<article class="article-content">' +
          '<video src="https://cdn.example.com/a.mp4" controls></video>' +
          '<video src="https://cdn.example.com/b.mp4" controls></video>' +
          "</article>",
      ),
      url: PAGE_URL,
    });
    expect(result.ambiguous).toBe(true);
    expect(summarizeVideoDetection(result)?.hint).toContain("自行挑选");
  });

  it("does not flag ambiguity when og:video declares a clear winner", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<article><video src="https://cdn.example.com/a.mp4" controls></video></article>',
        '<meta property="og:video" content="https://cdn.example.com/main.mp4">',
      ),
      url: PAGE_URL,
    });
    expect(result.ambiguous).toBe(false);
  });

  it("merges duplicate URLs discovered through multiple signals", async () => {
    const result = await detectVideoCandidates({
      html: page(
        '<article><video src="https://cdn.example.com/main.mp4" controls></video></article>',
        '<meta property="og:video" content="https://cdn.example.com/main.mp4">',
      ),
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://cdn.example.com/main.mp4");
    expect(result.others).toEqual([]);
    expect(result.main?.reasons.length).toBeGreaterThan(1);
  });

  it("ignores data: and blob: sources", async () => {
    const result = await detectVideoCandidates({
      html: page('<article><video src="blob:https://news.example.com/abc"></video></article>'),
      url: PAGE_URL,
    });
    expect(result.main).toBeUndefined();
  });

  it("survives malformed HTML by falling back to the script scan", async () => {
    const result = await detectVideoCandidates({
      html: '<html><body><div><script>{"url":"https://cdn.example.com/broken.mp4"}',
      url: PAGE_URL,
    });
    expect(result.main?.url).toBe("https://cdn.example.com/broken.mp4");
  });
});

describe("summarizeVideoDetection", () => {
  it("reports the candidate count and a call-to-action hint", async () => {
    const detection = await detectVideoCandidates({
      html: page(
        '<article class="article-content"><video src="https://cdn.example.com/story.mp4" controls></video></article>',
        '<meta property="og:video" content="https://cdn.example.com/main.mp4">',
      ),
      url: PAGE_URL,
    });
    const summary = summarizeVideoDetection(detection);
    expect(summary?.count).toBe(2);
    expect(summary?.main.url).toBe("https://cdn.example.com/main.mp4");
    expect(summary?.hint).toContain("video_understand");
  });
});

describe("resolveVideoPlatform", () => {
  it("recognizes pure video hosts from the hostname alone", () => {
    expect(resolveVideoPlatform("https://v.douyin.com/abc/")).toBe("抖音");
    expect(resolveVideoPlatform("https://b23.tv/abc")).toBe("哔哩哔哩");
    expect(resolveVideoPlatform("https://youtu.be/abc")).toBe("YouTube");
  });

  it("requires a video-shaped path on mixed-content hosts", () => {
    expect(resolveVideoPlatform("https://weibo.com/tv/show/1034:abc")).toBe("微博");
    expect(resolveVideoPlatform("https://weibo.com/login.php")).toBeUndefined();
    expect(resolveVideoPlatform("https://x.com/someone/status/123")).toBe("X");
    expect(resolveVideoPlatform("https://x.com/someone")).toBeUndefined();
  });

  it("returns undefined for ordinary news hosts and invalid URLs", () => {
    expect(resolveVideoPlatform("https://news.example.com/a.html")).toBeUndefined();
    expect(resolveVideoPlatform("not a url")).toBeUndefined();
  });
});

describe("parseIsoDurationSeconds", () => {
  it("parses ISO-8601 durations", () => {
    expect(parseIsoDurationSeconds("PT2M14S")).toBe(134);
    expect(parseIsoDurationSeconds("PT1H2M3S")).toBe(3723);
    expect(parseIsoDurationSeconds("PT30S")).toBe(30);
  });

  it("falls back to a bare number and rejects junk", () => {
    expect(parseIsoDurationSeconds("134")).toBe(134);
    expect(parseIsoDurationSeconds("")).toBeUndefined();
    expect(parseIsoDurationSeconds(undefined)).toBeUndefined();
    expect(parseIsoDurationSeconds("abc")).toBeUndefined();
  });
});
