import { beforeEach, expect, it, vi } from "vitest";
import { localPlatforms, resolveLocalConfig } from "../complaint-local-contract.js";
import { checkComplaintRuntime, runComplaint } from "./router.js";
const mocks = vi.hoisted(() => ({ python: vi.fn(), native: vi.fn(), check: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.python, execFile: mocks.python }));
vi.mock("./native.runtime.js", () => ({ runNativeComplaint: mocks.native }));
beforeEach(() => vi.clearAllMocks());
const params = {
  item: {
    platform: "douyin",
    link: "https://www.douyin.com/video/123",
    category: "不实信息",
    reason: "fixture",
    role: "Personal" as const,
  },
  sessionDir: "fixture",
  config: resolveLocalConfig({}),
  signal: new AbortController().signal,
};
it("does not require Python for a native-only batch", async () => {
  expect(await checkComplaintRuntime(params.config, [params.item])).toBeNull();
  expect(mocks.check).not.toHaveBeenCalled();
});
it("never falls back to Python when the native execution fails", async () => {
  mocks.native.mockRejectedValue(new Error("fixture failure"));
  await expect(runComplaint(params)).rejects.toThrow("fixture failure");
  expect(mocks.python).not.toHaveBeenCalled();
});
it.each([...Object.keys(localPlatforms), "report12377"])(
  "routes %s exclusively to TypeScript",
  async (platform) => {
    mocks.native.mockResolvedValue({ state: "done" });
    const item = { ...params.item, platform };
    expect(await checkComplaintRuntime(params.config, [item])).toBeNull();
    await runComplaint({ ...params, item });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.python).not.toHaveBeenCalled();
    expect(mocks.native).toHaveBeenCalledOnce();
  },
);
