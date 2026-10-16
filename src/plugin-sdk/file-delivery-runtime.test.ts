import { expect, it, vi } from "vitest";
import { uploadFileForDelivery } from "./file-delivery-runtime.js";

const runtime = vi.hoisted(() => ({ loaded: false, upload: vi.fn() }));
vi.mock("../infra/file-delivery.runtime.js", () => {
  runtime.loaded = true;
  return { uploadFileForDelivery: runtime.upload };
});

it("loads storage only on an upload and preserves the versioned request and result", async () => {
  expect(runtime.loaded).toBe(false);
  const request = { version: 1 as const, data: new Uint8Array([1]), displayName: "fixture.png" };
  const result = {
    version: 1,
    url: "https://images.example.test/fixture.png",
    objectKey: "fixture.png",
    size: 1,
  };
  runtime.upload.mockResolvedValue(result);
  expect(await uploadFileForDelivery(request)).toBe(result);
  expect(runtime.loaded).toBe(true);
  expect(runtime.upload).toHaveBeenCalledExactlyOnceWith(request);
});
