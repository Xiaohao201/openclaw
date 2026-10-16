import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { uploadFileForDelivery } from "openclaw/plugin-sdk/file-delivery-runtime";
import { z } from "zod";
import type { LocalOutcome } from "./complaint-local-contract.js";

const MAX_BYTES = 10 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function uploadComplaintScreenshot(
  sessionDir: string,
  screenshot: NonNullable<LocalOutcome["screenshot"]>,
): Promise<string> {
  const name = z
    .string()
    .regex(/^[a-f0-9]{32}\.png$/)
    .parse(screenshot.fileName);
  const root = await realpath(sessionDir);
  const filePath = await realpath(join(root, "screenshots", name));
  const within = relative(root, filePath);
  if (isAbsolute(within) || within.startsWith("..")) {
    throw new Error("Screenshot is outside the current browser session");
  }
  const file = await open(filePath, "r");
  let data: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < PNG.length || stat.size > MAX_BYTES) {
      throw new Error("Invalid screenshot size");
    }
    // Read a bounded snapshot even if the file changes after stat.
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) {
        break;
      }
      size += read.bytesRead;
    }
    if (size !== stat.size || !buffer.subarray(0, PNG.length).equals(PNG)) {
      throw new Error("Invalid screenshot content");
    }
    data = buffer.subarray(0, size);
  } finally {
    await file.close();
  }
  const result = await uploadFileForDelivery({
    version: 1,
    data,
    displayName: "complaint-result.png",
  });
  const url = z.string().url().max(255).parse(result.url);
  if (new URL(url).protocol !== "https:") {
    throw new Error("Screenshot delivery must use HTTPS");
  }
  return url;
}
