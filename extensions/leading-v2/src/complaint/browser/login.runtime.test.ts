import { beforeEach, expect, it, vi } from "vitest";
import { openComplaintLogin } from "./login.runtime.js";

const f = vi.hoisted(() => ({
  acquire: vi.fn(),
  goto: vi.fn(),
  screenshot: vi.fn(),
  release: vi.fn(),
  all: vi.fn(),
}));
vi.mock("./session.runtime.js", () => ({ acquireComplaintPage: f.acquire }));
const params = {
  platform: "douyin",
  allowFakeIp: false,
  handoff: {
    version: 1 as const,
    targetId: "target",
    marker: "marker",
    binding: { version: 1, profileDir: "fixture", cdpUrl: "http://127.0.0.1:1234" },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  f.goto.mockResolvedValue(undefined);
  f.release.mockResolvedValue(undefined);
  f.all.mockResolvedValue([]);
  f.screenshot.mockResolvedValue(Buffer.from("fixture"));
  f.acquire.mockResolvedValue({
    page: { goto: f.goto, getByText: () => ({ all: f.all }), screenshot: f.screenshot },
    release: f.release,
  });
});
it("opens only the trusted platform login URL and preserves the borrowed connection", async () => {
  const hidden = { isVisible: async () => false, click: vi.fn() };
  const visible = { isVisible: async () => true, click: vi.fn().mockResolvedValue(undefined) };
  f.all.mockResolvedValueOnce([hidden, visible]);
  const connection = await openComplaintLogin(params);
  expect(f.acquire).toHaveBeenCalledWith(params);
  expect(f.goto).toHaveBeenCalledWith("https://www.douyin.com", expect.any(Object));
  expect(hidden.click).not.toHaveBeenCalled();
  expect(visible.click).toHaveBeenCalledOnce();
  expect(connection.targetId).toBe("target");
  expect(await connection.screenshot()).toBe(Buffer.from("fixture").toString("base64"));
  expect(f.release).not.toHaveBeenCalled();
  await connection.release();
  expect(f.release).toHaveBeenCalledOnce();
});
it("rejects unknown platforms before connecting", async () => {
  await expect(openComplaintLogin({ ...params, platform: "constructor" })).rejects.toThrow(
    "Unsupported",
  );
  expect(f.acquire).not.toHaveBeenCalled();
});
it("releases the connection after navigation failure", async () => {
  f.goto.mockRejectedValueOnce(new Error("navigation failed"));
  await expect(openComplaintLogin(params)).rejects.toThrow("navigation failed");
  expect(f.release).toHaveBeenCalledOnce();
});
it("bounds screenshot payloads", async () => {
  const connection = await openComplaintLogin(params);
  f.screenshot.mockResolvedValue(Buffer.alloc(3000001));
  await expect(connection.screenshot()).rejects.toThrow("too large");
  await connection.release();
});
