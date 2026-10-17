import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => mocks);
import { PhoneBridge, quoteDeviceArgument } from "./bridge.js";
const jarPath = fileURLToPath(new URL("../../../assets/uiautomator/u2.jar", import.meta.url));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue(new Response("pong"));
  vi.stubGlobal("fetch", fetchMock);
  mocks.execFile.mockImplementation((_exe, args, _options, callback) => {
    callback(null, Buffer.from(args.includes("tcp:0") ? "19008" : "ok"));
  });
});
afterEach(() => vi.unstubAllGlobals());
const fixture = (signal = new AbortController().signal) =>
  new PhoneBridge({
    adbPath: "adb",
    serial: "test-device",
    jarPath,
    signal,
  });
it("borrows a running bridge and removes only its own forward, even after cancellation", async () => {
  const controller = new AbortController();
  const bridge = fixture(controller.signal);
  await bridge.start();
  await bridge.shell("input", "text", "a'b; echo forbidden");
  expect(quoteDeviceArgument("a'b")).toBe("'a'\\''b'");
  expect(mocks.execFile).toHaveBeenLastCalledWith(
    "adb",
    ["-s", "test-device", "shell", "'input' 'text' 'a'\\''b; echo forbidden'"],
    expect.objectContaining({ shell: false, windowsHide: true }),
    expect.any(Function),
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
  controller.abort();
  await expect(bridge.call("click")).rejects.toThrow("interrupted");
  await bridge.close();
  expect(mocks.execFile.mock.calls.at(-1)?.[1]).toEqual([
    "-s",
    "test-device",
    "forward",
    "--remove",
    "tcp:19008",
  ]);
});
it("checks RPC ids and errors and never retries a failed action", async () => {
  const bridge = fixture();
  await bridge.start();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: "中文" })));
  expect(await bridge.call("getClipboard")).toBe("中文");
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: true })));
  await expect(bridge.call("click")).rejects.toThrow("RPC failed");
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ id: 3, error: { message: "failed" } })),
  );
  await expect(bridge.call("click")).rejects.toThrow("RPC failed");
  fetchMock.mockRejectedValueOnce(new Error("lost response"));
  await expect(bridge.call("click")).rejects.toThrow("lost response");
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:19008/jsonrpc/0");
  await bridge.close();
});
it("starts the pinned server without installing an APK or invoking Python", async () => {
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(new Response("not running"))
    .mockResolvedValueOnce(new Response("pong"));
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const bridge = fixture();
  await bridge.start();
  expect(mocks.execFile.mock.calls.some((call) => call[1].includes("push"))).toBe(true);
  expect(mocks.spawn).toHaveBeenCalledWith(
    "adb",
    expect.arrayContaining(["shell", expect.stringContaining("com.wetest.uia2.Main")]),
    { shell: false, windowsHide: true, stdio: "ignore" },
  );
  await bridge.close();
  expect(child.kill).toHaveBeenCalledOnce();
});
it("rejects invalid ports, unavailable commands, oversized and missing HTTP bodies", async () => {
  mocks.execFile.mockImplementationOnce((_exe, _args, _options, callback) =>
    callback(null, Buffer.from("bad")),
  );
  await expect(fixture().start()).rejects.toThrow("port");
  mocks.execFile.mockImplementationOnce((_exe, _args, _options, callback) =>
    callback(new Error("no adb")),
  );
  await expect(fixture().start()).rejects.toThrow("ADB");
  const bridge = fixture();
  await expect(bridge.call("count")).rejects.toThrow("not connected");
  await bridge.start();
  fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
  await expect(bridge.call("count")).rejects.toThrow("HTTP");
  fetchMock.mockResolvedValueOnce(new Response(null));
  await expect(bridge.call("count")).rejects.toThrow("Missing");
  fetchMock.mockResolvedValueOnce(new Response("x".repeat(2000001)));
  await expect(bridge.call("count")).rejects.toThrow("too large");
  await bridge.close();
});
