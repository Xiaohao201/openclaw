import { expect, it, vi } from "vitest";
import type { PhoneBridge } from "./bridge.js";
import { NativePhone } from "./device.js";
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
const node = (text: string, type = "android.widget.TextView") =>
  `<node package="com.xingin.xhs" class="${type}" text="${text}" bounds="[0,0][100,100]" enabled="true"/>`;
it("blocks submit at the device boundary during preflight", async () => {
  const phone = new NativePhone({} as PhoneBridge, vi.fn(), false);
  await expect(phone.tap("提交")).rejects.toThrow("disabled");
});
it("opens only unlocked notes, taps visible controls and verifies preflight text cleanup", async () => {
  let screen = "note";
  let value = "fixture";
  const shell = vi.fn(async (...args: string[]): Promise<string> => {
    if (args.includes("policy")) {
      return "showing=false";
    }
    if (args.includes("tap")) {
      screen = "note";
    }
    return "mCurrentFocus=Window com.xingin.xhs/Main";
  });
  const call = vi.fn(async (method: string) => {
    if (method === "clearTextField") {
      value = "";
      return true;
    }
    if (method === "dumpWindowHierarchy") {
      return `<hierarchy>${screen === "note" ? '<node package="com.xingin.xhs" resource-id="com.xingin.xhs:id/moreOperateIV" bounds="[0,0][100,100]"/>' : node(value, "android.widget.EditText") + node("举报") + node("返回")}</hierarchy>`;
    }
    throw new Error("Unexpected RPC");
  });
  const run = vi.fn().mockResolvedValue(Buffer.from("image"));
  const phone = new NativePhone({ shell, call, run } as unknown as PhoneBridge, vi.fn());
  await expect(phone.open("invalid")).rejects.toThrow("Invalid note");
  shell.mockResolvedValueOnce("showing=true");
  await expect(phone.open("0123456789abcdef01234567")).rejects.toThrow("locked");
  await phone.open("0123456789abcdef01234567");
  expect(shell).toHaveBeenCalledWith(
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "xhsdiscover://item/0123456789abcdef01234567?type=normal",
    "-p",
    "com.xingin.xhs",
  );
  await phone.tap("更多");
  expect(shell).toHaveBeenCalledWith("input", "tap", "50", "50");
  screen = "form";
  await phone.cleanupPreflight("fixture");
  expect(value).toBe("");
  expect(await phone.screenshot()).toEqual(Buffer.from("image"));
  expect(run).toHaveBeenCalledWith(["exec-out", "screencap", "-p"]);
  await expect(phone.checkSubmitReady()).rejects.toThrow("not ready");
});
it("selects a nested category, and refuses identity workflows or unresolved labels", async () => {
  const phone = new NativePhone({} as PhoneBridge, vi.fn());
  const texts = vi.spyOn(phone, "texts");
  const tap = vi.spyOn(phone, "tap").mockResolvedValue(undefined);
  texts
    .mockResolvedValueOnce(["对他人造成困扰或危害"])
    .mockResolvedValueOnce(["不实信息、谣言"])
    .mockResolvedValueOnce(["下一步"]);
  await phone.selectCategory("对他人造成困扰或危害", "不实信息");
  expect(tap.mock.calls.map(([label]) => label)).toEqual([
    "对他人造成困扰或危害",
    "不实信息、谣言",
    "下一步",
  ]);
  await expect(phone.selectCategory("侵犯我的权益")).rejects.toThrow("Identity");
  texts.mockResolvedValue(["其他"]);
  await expect(phone.selectCategory("不实信息")).rejects.toThrow("Unresolved");
  texts
    .mockResolvedValueOnce(["不实信息"])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(["广告"]);
  await phone.selectCategory("不实信息", "广告");
  await phone.openReport();
  expect(tap).toHaveBeenLastCalledWith("举报", "horizontal");
});
it("scrolls only the observed report surface and stops when the screen no longer changes", async () => {
  const shell = vi.fn().mockResolvedValue("mCurrentFocus=Window com.xingin.xhs/Main");
  const phone = new NativePhone({ shell } as unknown as PhoneBridge, vi.fn());
  const item = (text: string) => ({
    package: "com.xingin.xhs",
    text,
    bounds: "[0,0][1000,1000]",
    path: "0",
    disabled: "false",
    enabled: "true",
  });
  const nodes = vi.spyOn(phone, "nodes");
  nodes.mockResolvedValueOnce([item("举报")]).mockResolvedValueOnce([item("提交")]);
  await phone.tap("提交", "vertical");
  expect(shell.mock.calls.some((args) => args.includes("swipe"))).toBe(true);
  nodes.mockResolvedValue([item("分享至"), { ...item("复制链接"), path: "1" }]);
  await expect(phone.tap("举报", "horizontal")).rejects.toThrow("missing");
  nodes.mockResolvedValue([item("unknown")]);
  await expect(phone.tap("提交", "vertical")).rejects.toThrow("Not a report");
  await expect(phone.tap("举报", "horizontal")).rejects.toThrow("Not a share");
  nodes.mockResolvedValue([item("提交")]);
  await phone.checkSubmitReady();
});
it("verifies and restores the clipboard before trusting the share URL", async () => {
  let clipboard = "original clipboard";
  const link = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
  const call = vi.fn(async (method: string, ...args: unknown[]) => {
    if (method === "getClipboard") {
      return clipboard;
    }
    if (method === "setClipboard") {
      clipboard = String(args[1]);
      return true;
    }
    if (method === "dumpWindowHierarchy") {
      return `<hierarchy>${node("分享至")}</hierarchy>`;
    }
    throw new Error("Unexpected method");
  });
  const bridge = {
    call,
    shell: vi.fn().mockResolvedValue("mCurrentFocus=Window com.xingin.xhs/Main"),
  } as unknown as PhoneBridge;
  const resolve = vi.fn().mockResolvedValue(link);
  const phone = new NativePhone(bridge, resolve);
  vi.spyOn(phone, "tap").mockImplementation(async (label) => {
    expect(label).toBe("复制链接");
    clipboard = "share " + link;
  });
  expect(await phone.copiedLink()).toBe(link);
  expect(clipboard).toBe("original clipboard");
  expect(resolve).toHaveBeenCalledWith(link);
});
it("uses the Unicode bridge and reads the exact description back before proceeding", async () => {
  let value = "";
  const call = vi.fn(async (method: string, ...args: unknown[]) => {
    if (method === "dumpWindowHierarchy") {
      return `<hierarchy>${node(value, "android.widget.EditText")}</hierarchy>`;
    }
    if (method === "count") {
      return 1;
    }
    if (method === "setText") {
      value = String(args[1]);
      return true;
    }
    throw new Error("Unexpected method");
  });
  const shell = vi.fn(
    async (...args: string[]): Promise<string> =>
      args.includes("input_method")
        ? "mInputShown=true"
        : "mCurrentFocus=Window com.xingin.xhs/Main",
  );
  const phone = new NativePhone({ call, shell } as unknown as PhoneBridge, vi.fn());
  await phone.fillReason("中文测试内容");
  expect(value).toBe("中文测试内容");
  expect(shell).toHaveBeenCalledWith("input", "keyevent", "4");
  await expect(phone.fillReason("x".repeat(401))).rejects.toThrow();
  shell.mockResolvedValueOnce("mCurrentFocus=Window other.app/Main");
  await expect(phone.nodes()).rejects.toThrow("foreground");
});
