import fs from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { acquireVideo, buildVideoSegmentRanges } from "./video-understand.runtime.js";

const { guardedFetch, release } = vi.hoisted(() => ({ guardedFetch: vi.fn(), release: vi.fn() }));
vi.mock("./web-guarded-fetch.js", () => ({ fetchWithWebToolsNetworkGuard: guardedFetch }));
vi.mock("../../infra/resolve-system-bin.js", () => ({ resolveSystemBin: () => undefined }));
beforeEach(() => {
  guardedFetch.mockReset();
  release.mockReset();
});

it("streams a direct video to disk and releases the request", async () => {
  guardedFetch.mockResolvedValue({ response: new Response(new Uint8Array([1, 2, 3])), release });
  await withTempDir({ prefix: "video-stream-" }, async (workDir) => {
    const video = await acquireVideo({ url: "https://cdn.example.com/video.mp4", workDir });
    expect(await fs.readFile(video.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(video.via).toBe("download");
    expect(release).toHaveBeenCalledOnce();
  });
});

it.each(["video/mp4", "Video/WebM; charset=binary", "application/octet-stream"])(
  "downloads extensionless media with content type %s without yt-dlp",
  async (contentType) => {
    const url = "https://v26-luna.douyinvod.com/video/example/?mime_type=video_mp4&signature=a%2Fb";
    guardedFetch.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": contentType },
      }),
      release,
    });
    await withTempDir({ prefix: "video-no-extension-" }, async (workDir) => {
      const video = await acquireVideo({ url, workDir });
      expect(video.via).toBe("download");
      expect(video.sourceUrl).toBe(url);
      expect(await fs.readFile(video.path)).toEqual(Buffer.from([1, 2, 3]));
      expect(guardedFetch).toHaveBeenCalledExactlyOnceWith({ url, timeoutMs: 300_000 });
      expect(release).toHaveBeenCalledOnce();
    });
  },
);

it("releases non-media responses before falling back to yt-dlp", async () => {
  guardedFetch.mockResolvedValue({
    response: new Response("<html>watch page</html>", { headers: { "content-type": "text/html" } }),
    release,
  });
  await withTempDir({ prefix: "video-page-" }, async (workDir) => {
    await expect(acquireVideo({ url: "https://example.com/watch/123", workDir })).rejects.toThrow(
      "yt-dlp",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(await fs.readdir(workDir)).toEqual([]);
  });
});

it("preserves HTTP failures for extensionless media instead of requesting yt-dlp", async () => {
  guardedFetch.mockResolvedValue({ response: new Response(null, { status: 403 }), release });
  await withTempDir({ prefix: "video-expired-" }, async (workDir) => {
    await expect(
      acquireVideo({ url: "https://cdn.example.com/video/123", workDir }),
    ).rejects.toThrow("HTTP 403");
    expect(release).toHaveBeenCalledOnce();
  });
});

it.each([
  [true, "https://cdn.example.com/video.mp4"],
  [false, "https://cdn.example.com/video.mp4"],
  [true, "https://cdn.example.com/video/123"],
  [false, "https://cdn.example.com/video/123"],
])("rejects oversized downloads with content-length=%s at %s", async (declared, url) => {
  guardedFetch.mockResolvedValue({
    response: new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "video/mp4", ...(declared ? { "content-length": "3" } : {}) },
    }),
    release,
  });
  await withTempDir({ prefix: "video-stream-limit-" }, async (workDir) => {
    await expect(acquireVideo({ url, workDir, maxBytes: 2 })).rejects.toThrow("exceeds");
    expect(release).toHaveBeenCalledOnce();
  });
});

it("keeps recognized platform pages on the yt-dlp route", async () => {
  await withTempDir({ prefix: "video-platform-" }, async (workDir) => {
    await expect(
      acquireVideo({ url: "https://www.douyin.com/share/video/123", workDir }),
    ).rejects.toThrow("yt-dlp");
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});

it("does not bypass a rejected network guard with yt-dlp", async () => {
  guardedFetch.mockRejectedValue(new Error("Blocked address"));
  await withTempDir({ prefix: "video-blocked-" }, async (workDir) => {
    await expect(
      acquireVideo({ url: "https://cdn.example.com/video/123", workDir }),
    ).rejects.toThrow("Blocked address");
  });
});

it("builds two-minute segments with five-second overlap", () => {
  expect(
    buildVideoSegmentRanges({ durationSeconds: 301, segmentSeconds: 120, overlapSeconds: 5 }),
  ).toEqual([
    { startSeconds: 0, endSeconds: 120 },
    { startSeconds: 115, endSeconds: 235 },
    { startSeconds: 230, endSeconds: 301 },
  ]);
});
