import fs from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { acquireVideo } from "./video-understand.runtime.js";

const { guardedFetch, release } = vi.hoisted(() => ({ guardedFetch: vi.fn(), release: vi.fn() }));
vi.mock("./web-guarded-fetch.js", () => ({ fetchWithWebToolsNetworkGuard: guardedFetch }));
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

it.each([true, false])("rejects oversized downloads with content-length=%s", async (declared) => {
  guardedFetch.mockResolvedValue({
    response: new Response(new Uint8Array([1, 2, 3]), {
      headers: declared ? { "content-length": "3" } : {},
    }),
    release,
  });
  await withTempDir({ prefix: "video-stream-limit-" }, async (workDir) => {
    await expect(
      acquireVideo({ url: "https://cdn.example.com/video.mp4", workDir, maxBytes: 2 }),
    ).rejects.toThrow("exceeds");
    expect(release).toHaveBeenCalledOnce();
  });
});
