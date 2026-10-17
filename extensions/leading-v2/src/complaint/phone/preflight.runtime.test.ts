import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../api.js";
const mocks = vi.hoisted(() => ({ run: vi.fn(), fetch: vi.fn() }));
vi.mock("./runtime.js", () => ({ runPhoneComplaint: mocks.run }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: mocks.fetch }));
import { phonePreflight } from "./preflight.runtime.js";
const link = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
const api = {
  pluginConfig: { complaintExecution: { phone: { serial: "fixture", userId: "owner" } } },
  config: {},
  runtime: { state: { resolveStateDir: () => "fixture-state" } },
} as unknown as OpenClawPluginApi;
it("authorizes the bound user before any device call and removes its interrupt handler", async () => {
  await expect(
    phonePreflight(api, { userId: "other", url: link, category: "不实信息" }),
  ).rejects.toThrow("configured user");
  expect(mocks.run).not.toHaveBeenCalled();
  const before = process.listenerCount("SIGINT");
  mocks.run.mockImplementationOnce(async (params) => {
    expect(params.preflight).toBe(true);
    expect(await params.resolveLink(link)).toBe(link);
    await expect(params.resolveLink("https://evil.test/a")).rejects.toThrow("Invalid");
    const cancel = vi.fn();
    const release = vi.fn();
    mocks.fetch.mockResolvedValueOnce({ finalUrl: link, response: { body: { cancel } }, release });
    expect(await params.resolveLink("http://xhslink.com/abc")).toBe(link);
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://xhslink.com/abc", capture: false, maxRedirects: 5 }),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValueOnce({ finalUrl: "https://evil.test/a", response: {}, release });
    await expect(params.resolveLink("https://xhslink.cn/abc")).rejects.toThrow("resolve");
    process.emit("SIGINT");
    expect(params.signal.aborted).toBe(true);
    return { errorCode: "PHONE_PREFLIGHT_READY" };
  });
  expect(
    (await phonePreflight(api, { userId: "owner", url: link, category: "不实信息" })).errorCode,
  ).toBe("PHONE_PREFLIGHT_READY");
  expect(process.listenerCount("SIGINT")).toBe(before);
});
