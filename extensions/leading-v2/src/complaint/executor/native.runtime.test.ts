import { beforeEach, expect, it, vi } from "vitest";
import { resolveLocalConfig } from "../complaint-local-contract.js";
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  phone: vi.fn(),
  report: vi.fn(),
  execute: vi.fn(),
  douyin: vi.fn(),
  web: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../browser/session.runtime.js", () => ({ acquireComplaintPage: mocks.acquire }));
vi.mock("../phone/runtime.js", () => ({ runPhoneComplaint: mocks.phone }));
vi.mock("../platforms/report12377.js", () => ({ runReport12377: mocks.report }));
vi.mock("../platforms/douyin.js", () => ({ createDouyinDriver: mocks.douyin }));
vi.mock("../platforms/web.js", () => ({ createWebDriver: mocks.web }));
vi.mock("./native.js", () => ({ executeNativeComplaint: mocks.execute }));
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: () => ({ info: mocks.log }),
}));
import { runNativeComplaint } from "./native.runtime.js";
const link = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
let url: string;
const page = {
  goto: vi.fn(async (value: string) => {
    url = value;
  }),
  url: () => url,
  locator: vi.fn(() => ({
    innerText: vi.fn().mockResolvedValue("当前内容仅支持在小红书APP内查看"),
  })),
};
const release = vi.fn();
const fixture = () => ({
  item: {
    platform: "xiaohongshu",
    link,
    category: "不实信息",
    reason: "fixture",
    role: "Personal" as const,
  },
  config: resolveLocalConfig({}),
  signal: new AbortController().signal,
  sessionDir: "fixture",
});
beforeEach(() => {
  vi.clearAllMocks();
  url = link;
  release.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue({ page, release });
  mocks.phone.mockResolvedValue({ state: "done" });
  mocks.report.mockResolvedValue({ state: "manual_required" });
  mocks.execute.mockImplementation(async ({ acquire }) => {
    await acquire();
    return { state: "unknown" };
  });
});
it("requires exact browser handoff and never substitutes an engine after attach failure", async () => {
  mocks.acquire.mockRejectedValueOnce(new Error("unavailable"));
  expect((await runNativeComplaint(fixture())).errorCode).toBe("BROWSER_HANDOFF_REQUIRED");
  expect(mocks.phone).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("uses the phone only on an explicit app-only gate and releases the shared page", async () => {
  expect((await runNativeComplaint(fixture())).state).toBe("done");
  expect(mocks.phone).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  const resolve = mocks.phone.mock.calls[0][0].resolveLink;
  await expect(resolve("https://evil.test/note")).rejects.toThrow("Not a note");
  await expect(resolve("https://user:secret@xhslink.com/test")).rejects.toThrow("Invalid");
  expect(await resolve(link)).toBe(link);
  page.locator.mockReturnValueOnce({ innerText: vi.fn().mockResolvedValue("normal note") });
  expect((await runNativeComplaint(fixture())).state).toBe("unknown");
  expect(mocks.phone).toHaveBeenCalledOnce();
});
it("runs 12377 with the same page and configured wait window", async () => {
  const p = fixture();
  await runNativeComplaint({
    ...p,
    item: { ...p.item, report12377: { category: "rumor", websiteName: "fixture" } },
  });
  expect(mocks.report).toHaveBeenCalledWith(
    expect.objectContaining({ page, timeoutMs: p.config.timeoutMs }),
  );
  expect(release).toHaveBeenCalledOnce();
});
it("normalizes Douyin targets without replacing a failed web submission", async () => {
  const p = fixture();
  release.mockRejectedValueOnce(new Error("cleanup"));
  expect(
    (
      await runNativeComplaint({
        ...p,
        item: {
          ...p.item,
          platform: "douyin",
          link: "https://www.douyin.com/jingxuan?modal_id=123",
        },
      })
    ).state,
  ).toBe("unknown");
  expect(mocks.douyin).toHaveBeenCalledWith(
    expect.objectContaining({
      item: expect.objectContaining({ link: "https://www.douyin.com/video/123" }),
    }),
  );
  expect(mocks.phone).not.toHaveBeenCalled();
  expect(
    (
      await runNativeComplaint({
        ...p,
        item: { ...p.item, platform: "douyin", link: "https://www.douyin.com/jingxuan" },
      })
    ).state,
  ).toBe("failed");
});
