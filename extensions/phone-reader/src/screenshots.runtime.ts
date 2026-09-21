import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { saveMediaBuffer } from "openclaw/plugin-sdk/browser-setup-tools";
import sharp from "sharp";
import type { Bounds } from "./gallery.js";

export async function prepareScreenshot(buffer: Buffer, bounds?: Bounds) {
  if (
    buffer.length > 16_000_000 ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("Invalid Android screenshot.");
  }
  const input = sharp(buffer, { limitInputPixels: 40_000_000 });
  const { width, height } = await input.metadata();
  if (!width || !height) {
    throw new Error("Missing screenshot dimensions.");
  }
  if (bounds) {
    if (
      bounds.left < 0 ||
      bounds.top < 0 ||
      bounds.left + bounds.width > width ||
      bounds.top + bounds.height > height
    ) {
      throw new Error("Gallery bounds do not match the screenshot; refusing to crop or swipe.");
    }
    input.extract(bounds);
  }
  // Normalize the pixels to compare gallery images without status-bar clock changes.
  const image = await input.png().toBuffer();
  return { image, hash: createHash("sha256").update(image).digest("hex") };
}

export async function captureScreenshot(
  adbPath: string,
  serial: string,
  bounds?: Bounds,
  signal?: AbortSignal,
) {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    // exec-out preserves PNG bytes on Windows and does not allocate a remote file.
    execFile(
      adbPath,
      ["-s", serial, "exec-out", "screencap", "-p"],
      { encoding: "buffer", timeout: 15000, maxBuffer: 16_000_000, windowsHide: true, signal },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
  const { image, hash } = await prepareScreenshot(buffer, bounds);
  const saved = await saveMediaBuffer(image, "image/png", "browser", 16_000_000);
  return { path: saved.path, hash };
}
