import { describe, expect, it, vi } from "vitest";
import {
  createAdbRunner,
  parseVisibleText,
  planNavigation,
  readPhone,
  selectDevice,
  shellQuote,
} from "./reader.js";

const url = "https://www.xiaohongshu.com/discovery/item/6ab0b58e0000000012002c2a";
const activity = "mResumedActivity: ActivityRecord{abc com.xingin.xhs/.NoteDetailActivity}";
const xml =
  '<hierarchy><node package="com.xingin.xhs" text="测试笔记 &amp; 内容"/><node package="other.app" text="private"/></hierarchy>';

describe("phone reader", () => {
  it("handles missing ADB, command output, and canceled execution", async () => {
    await expect(createAdbRunner("openclaw-nonexistent-adb")([])).rejects.toMatchObject({
      code: "device_unavailable",
    });
    expect(await createAdbRunner(process.execPath)(["-e", "process.stdout.write('ready')"])).toBe(
      "ready",
    );
    await expect(
      createAdbRunner(process.execPath, AbortSignal.abort())(["-e", "0"]),
    ).rejects.toMatchObject({ code: "device_unavailable" });
  });
  it("releases the device lock after navigation failure", async () => {
    const release = vi.fn(async () => {});
    const run = async (args: string[]) =>
      args[0] === "devices" ? "test device" : "Error: Activity not found";
    await expect(readPhone(url, {}, { run, lock: async () => release })).rejects.toMatchObject({
      code: "navigation_unconfirmed",
    });
    expect(release).toHaveBeenCalledOnce();
  });
  it("prevents concurrent operations on the same phone and releases after failure", async () => {
    let unlock!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = async (args: string[]) => {
      if (args[0] === "devices") {
        return `test-${process.pid} device`;
      }
      entered();
      await waiting;
      return "Error: Activity not found";
    };
    const first = readPhone(url, {}, { run });
    const failed = expect(first).rejects.toMatchObject({ code: "navigation_unconfirmed" });
    await started;
    try {
      await expect(readPhone(url, {}, { run })).rejects.toMatchObject({ code: "device_busy" });
    } finally {
      unlock();
    }
    await failed;
    await expect(readPhone(url, {}, { run })).rejects.toMatchObject({
      code: "navigation_unconfirmed",
    });
  });
  it("cleans the remote dump when UI parsing fails", async () => {
    const run = vi.fn(async (args: string[]) => {
      const command = args.join(" ");
      if (args[0] === "devices") {
        return "test device";
      }
      if (command.includes("activities")) {
        return activity;
      }
      if (command.includes("'cat'")) {
        return "broken XML";
      }
      return "";
    });
    await expect(
      readPhone(url, {}, { run, sleep: async () => {}, lock: async () => async () => {} }),
    ).rejects.toMatchObject({ code: "invalid_ui" });
    expect(run.mock.calls.some(([args]) => args.join(" ").includes("'rm' '-f'"))).toBe(true);
  });
  it("routes XHS notes without losing the target ID", () => {
    expect(planNavigation(url, []).uri).toBe(
      "xhsdiscover://item/6ab0b58e0000000012002c2a?type=normal",
    );
  });
  it.each([
    "file:///etc/passwd",
    "https://user@xiaohongshu.com/explore/abc",
    "https://xiaohongshu.com.evil.test/",
    "https://xiaohongshu.com:444/explore/abc",
  ])("rejects unsupported URL %s", (value) => {
    expect(() => planNavigation(value, [])).toThrow();
  });
  it("supports configured apps and quotes remote shell arguments", () => {
    const value = "https://example.com/a?q=';reboot&b=2";
    expect(
      planNavigation(value, [{ host: "example.com", package: "com.example.app" }]).package,
    ).toBe("com.example.app");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
  it("requires an explicit serial with multiple phones", () => {
    const devices = "List of devices attached\na device\nb device\nc unauthorized\n";
    expect(() => selectDevice(devices)).toThrow("multiple");
    expect(selectDevice(devices, "b")).toBe("b");
    expect(() => selectDevice(devices, "c")).toThrow();
  });
  it("extracts only the target app and rejects malformed XML", () => {
    expect(parseVisibleText(xml, "com.xingin.xhs")).toEqual(["测试笔记 & 内容"]);
    expect(() => parseVisibleText("<!DOCTYPE x><hierarchy/>", "x")).toThrow();
    expect(() => parseVisibleText("<hierarchy>", "x")).toThrow();
  });
  it("reads a stable foreground page and cleans remote files", async () => {
    const run = vi.fn(async (args: string[]) => {
      const command = args.join(" ");
      if (command === "devices") {
        return "List of devices attached\ntest device\n";
      }
      if (command.includes("activities")) {
        return activity;
      }
      if (command.includes("'cat'")) {
        return xml;
      }
      return "";
    });
    const result = await readPhone(
      url,
      {},
      { run, sleep: async () => {}, lock: async () => async () => {} },
    );
    expect(result).toMatchObject({
      identityVerified: false,
      scope: "current_screen",
      text: "测试笔记 & 内容",
    });
    expect(run.mock.calls.some(([args]) => args.join(" ").includes("'rm' '-f'"))).toBe(true);
  });
  it("does not launch on a locked phone", async () => {
    const run = vi.fn(async (args: string[]) =>
      args[0] === "devices" ? "test device" : "mShowingLockscreen=true",
    );
    await expect(
      readPhone(url, {}, { run, sleep: async () => {}, lock: async () => async () => {} }),
    ).rejects.toThrow("Unlock");
    expect(run.mock.calls.some(([args]) => args.join(" ").includes("'start'"))).toBe(false);
  });
  it("never returns a different foreground app", async () => {
    const run = async (args: string[]) =>
      args[0] === "devices" ? "test device" : "mResumedActivity: other.app/.Home";
    await expect(
      readPhone(url, {}, { run, sleep: async () => {}, lock: async () => async () => {} }),
    ).rejects.toThrow("foreground");
  });
});
