import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOssConfig, uploadFileToOss } from "./aliyun-oss.js";
import { uploadFileForDelivery } from "./file-delivery.runtime.js";

vi.mock("./aliyun-oss.js", () => ({
  resolveOssConfig: vi.fn(),
  uploadFileToOss: vi.fn(),
  fileExtension: (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "",
}));
const config = {
  accessKeyId: "fixture",
  accessKeySecret: "fixture",
  bucket: "fixture",
  endpoint: "oss.example.test",
  customDomain: "https://images.example.test",
  pathPrefix: "fixtures",
  maxFileSizeMb: 1,
  allowedExtensions: ["png"],
};
const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const request = { version: 1 as const, data, displayName: "receipt.png" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveOssConfig).mockReturnValue(config);
});
describe("host file delivery", () => {
  it("uploads the exact private snapshot and removes it after delivery", async () => {
    let localPath = "";
    vi.mocked(uploadFileToOss).mockImplementation(async (args) => {
      localPath = args.localPath;
      expect(await readFile(localPath)).toEqual(Buffer.from(data));
      expect(args.config).toBe(config);
      expect(args.displayName).toBe("receipt.png");
      const fetchMock = vi.fn().mockResolvedValue(new Response());
      vi.stubGlobal("fetch", fetchMock);
      try {
        await args.fetchImpl!("https://oss.example.test/fixture", { method: "PUT" });
        expect(fetchMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            method: "PUT",
            signal: expect.any(AbortSignal),
          }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
      return {
        url: "https://images.example.test/receipt.png",
        objectKey: "fixture.png",
        size: data.length,
      };
    });
    expect(await uploadFileForDelivery(request)).toMatchObject({ version: 1, size: data.length });
    await expect(access(dirname(localPath))).rejects.toThrow();
  });
  it("removes its temporary snapshot when uploading fails", async () => {
    let localPath = "";
    vi.mocked(uploadFileToOss).mockImplementation(async (args) => {
      localPath = args.localPath;
      throw new Error("offline storage");
    });
    await expect(uploadFileForDelivery(request)).rejects.toThrow("offline storage");
    await expect(access(dirname(localPath))).rejects.toThrow();
  });
  it("fails clearly when the host has no storage configuration", async () => {
    vi.mocked(resolveOssConfig).mockReturnValue(null);
    await expect(uploadFileForDelivery(request)).rejects.toThrow("not configured");
    expect(uploadFileToOss).not.toHaveBeenCalled();
  });
  it.each([
    { ...request, data: new Uint8Array() },
    { ...request, data: new Uint8Array(1024 * 1024 + 1) },
    { ...request, displayName: "receipt.exe" },
  ])("rejects an artifact outside configured limits", async (input) => {
    await expect(uploadFileForDelivery(input)).rejects.toThrow("limits");
    expect(uploadFileToOss).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])(
    "rejects invalid size configuration %s",
    async (maxFileSizeMb) => {
      vi.mocked(resolveOssConfig).mockReturnValue({ ...config, maxFileSizeMb });
      await expect(uploadFileForDelivery(request)).rejects.toThrow("limits");
      expect(uploadFileToOss).not.toHaveBeenCalled();
    },
  );
});
