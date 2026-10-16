import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFileForDelivery } from "openclaw/plugin-sdk/file-delivery-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadComplaintScreenshot } from "./complaint-evidence.runtime.js";

vi.mock("openclaw/plugin-sdk/file-delivery-runtime", () => ({ uploadFileForDelivery: vi.fn() }));
const screenshot = { fileName: "a".repeat(32) + ".png", capturedAt: "2026-10-16T00:00:00Z" };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
let root: string;
let session: string;
let file: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "complaint-evidence-"));
  session = join(root, "session");
  await mkdir(join(session, "screenshots"), { recursive: true });
  file = join(session, "screenshots", screenshot.fileName);
  await writeFile(file, png);
  vi.mocked(uploadFileForDelivery).mockResolvedValue({
    version: 1,
    url: "https://images.example.test/receipt.png",
    objectKey: "receipt.png",
    size: png.length,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("complaint screenshot delivery", () => {
  it("uploads only PNG bytes from the current session and keeps the local recovery copy", async () => {
    expect(await uploadComplaintScreenshot(session, screenshot)).toBe(
      "https://images.example.test/receipt.png",
    );
    expect(uploadFileForDelivery).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      data: png,
      displayName: "complaint-result.png",
    });
    expect(await readFile(file)).toEqual(png);
  });
  it.each(["../receipt.png", "C:\\private.png", "receipt.jpg"])(
    "rejects an unsafe filename %s",
    async (fileName) => {
      await expect(
        uploadComplaintScreenshot(session, { ...screenshot, fileName }),
      ).rejects.toThrow();
      expect(uploadFileForDelivery).not.toHaveBeenCalled();
    },
  );
  it("rejects a screenshot directory redirected outside the session", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, screenshot.fileName), png);
    await rm(join(session, "screenshots"), { recursive: true });
    await symlink(
      outside,
      join(session, "screenshots"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(uploadComplaintScreenshot(session, screenshot)).rejects.toThrow("outside");
    expect(uploadFileForDelivery).not.toHaveBeenCalled();
  });
  it.each([Buffer.alloc(0), Buffer.from("not an image"), Buffer.alloc(10 * 1024 * 1024 + 1)])(
    "rejects empty, non-PNG and oversized input",
    async (data) => {
      await writeFile(file, data);
      await expect(uploadComplaintScreenshot(session, screenshot)).rejects.toThrow();
      expect(uploadFileForDelivery).not.toHaveBeenCalled();
    },
  );
  it.each([
    "http://images.example.test/receipt.png",
    "https://images.example.test/" + "x".repeat(256),
  ])("rejects a URL that cannot safely be stored", async (url) => {
    vi.mocked(uploadFileForDelivery).mockResolvedValue({
      version: 1,
      url,
      objectKey: "fixture",
      size: png.length,
    });
    await expect(uploadComplaintScreenshot(session, screenshot)).rejects.toThrow();
  });
  it("preserves the original screenshot after an upload failure", async () => {
    vi.mocked(uploadFileForDelivery).mockRejectedValue(new Error("offline"));
    await expect(uploadComplaintScreenshot(session, screenshot)).rejects.toThrow("offline");
    expect(await readFile(file)).toEqual(png);
  });
});
