import { afterEach, expect, it, vi } from "vitest";
import { LoginSession } from "./login-session.js";
afterEach(() => vi.useRealTimers());
const fixture = () => {
  const release = vi.fn().mockResolvedValue(undefined);
  const screenshot = vi.fn().mockResolvedValue("fixture-jpeg");
  const connect = vi.fn().mockResolvedValue({ targetId: "tab", screenshot, release });
  const session = new LoginSession({
    platform: "douyin",
    sessionKey: "key",
    sessionId: "id",
    connect,
  });
  return { release, screenshot, connect, session };
};
it("preserves the tab and releases ownership once on finish", async () => {
  const f = fixture();
  expect(await f.session.start()).toMatchObject({ state: "awaiting_login" });
  expect(await f.session.command("finish")).toMatchObject({ state: "saved" });
  await f.session.stop();
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.session.targetId).toBe("tab");
});
it("does not retain screenshot content in status", async () => {
  const f = fixture();
  await f.session.start();
  expect(await f.session.command("screenshot")).toMatchObject({ screenshot: "fixture-jpeg" });
  expect(f.session.latest).not.toHaveProperty("screenshot");
  await f.session.stop();
});
it("expires and releases an idle session", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.session.start();
  await vi.advanceTimersByTimeAsync(600001);
  expect(f.session.latest.state).toBe("expired");
  expect(f.release).toHaveBeenCalledOnce();
});
it("waits for in-flight screenshots before shutdown releases the connection", async () => {
  const f = fixture();
  await f.session.start();
  let finish!: (value: string) => void;
  f.screenshot.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const shot = f.session.command("screenshot");
  expect(await f.session.command("finish")).toMatchObject({ state: "busy" });
  const stopped = f.session.stop();
  expect(f.release).not.toHaveBeenCalled();
  finish("fixture");
  await shot;
  await stopped;
  expect(f.release).toHaveBeenCalledOnce();
});
it("does not leak connection errors or leave a usable session after failure", async () => {
  const f = fixture();
  f.connect.mockRejectedValue(new Error("secret cookie"));
  expect(await f.session.start()).toMatchObject({
    state: "failed",
    errorCode: "BROWSER_LOGIN_FAILED",
  });
  expect(JSON.stringify(f.session.latest)).not.toContain("secret");
  expect(f.session.closed).toBe(true);
});
it("releases after oversized screenshots and reports cleanup failure safely", async () => {
  const f = fixture();
  await f.session.start();
  f.screenshot.mockResolvedValue("x".repeat(4000001));
  f.release.mockRejectedValue(new Error("private cleanup details"));
  expect(await f.session.command("screenshot")).toMatchObject({ state: "failed" });
  expect(f.release).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.session.latest)).not.toContain("private");
  expect(await f.session.command("finish")).toMatchObject({ state: "failed" });
});
