import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { captureScreenshot, prepareScreenshot } from "./screenshots.runtime.js";

const capture = vi.hoisted((): { buffer: Buffer; error: Error | null } => ({
  buffer: Buffer.alloc(0),
  error: null,
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(capture.error, capture.buffer)),
}));
vi.mock("openclaw/plugin-sdk/browser-setup-tools", () => ({ saveMediaBuffer: vi.fn() }));
describe("phone screenshots", () => {
  it("preserves binary ADB output and stores images in the image tool media root", async () => {
    capture.buffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    vi.mocked(saveMediaBuffer).mockResolvedValue({
      path: "screen.png",
      id: "test",
      size: 100,
      contentType: "image/png",
    });
    expect(await captureScreenshot("adb", "test")).toMatchObject({ path: "screen.png" });
    expect(execFile).toHaveBeenCalledWith(
      "adb",
      ["-s", "test", "exec-out", "screencap", "-p"],
      expect.objectContaining({ encoding: "buffer", windowsHide: true }),
      expect.any(Function),
    );
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
      "browser",
      16_000_000,
    );
    capture.error = new Error("Disconnected");
    try {
      await expect(captureScreenshot("adb", "test")).rejects.toThrow("Disconnected");
    } finally {
      capture.error = null;
    }
  });
  it("crops to accessible gallery bounds at the original resolution", async () => {
    const input = await sharp({
      create: { width: 400, height: 800, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const { image, hash } = await prepareScreenshot(input, {
      left: 10,
      top: 100,
      width: 300,
      height: 500,
    });
    expect(await sharp(image).metadata()).toMatchObject({ width: 300, height: 500 });
    expect(hash).toHaveLength(64);
    await expect(
      prepareScreenshot(input, { left: 10, top: 100, width: 800, height: 500 }),
    ).rejects.toThrow("bounds");
    await expect(prepareScreenshot(Buffer.from("bad"))).rejects.toThrow("Invalid");
  });
});
import { execFile } from "node:child_process";
import { saveMediaBuffer } from "openclaw/plugin-sdk/browser-setup-tools";
