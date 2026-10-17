import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { selectDouyinCategory } from "../platforms/douyin.js";
import { PhoneBridge } from "./bridge.js";
import type { PhonePort } from "./submit.js";
import { parsePhoneNodes, phoneBounds, selectPhoneNode, type PhoneNode } from "./ui.js";

export class NativePhone implements PhonePort {
  constructor(
    readonly bridge: PhoneBridge,
    private readonly resolveLink: (value: string) => Promise<string>,
    private readonly allowSubmit = true,
  ) {}
  async foreground() {
    if (
      !/mCurrentFocus=[^\n]*\scom\.xingin\.xhs\//.test(
        await this.bridge.shell("dumpsys", "window", "windows"),
      )
    ) {
      throw new Error("XHS not foreground");
    }
  }
  async open(identity: string) {
    if (!/^[a-f0-9]{24}$/.test(identity)) {
      throw new Error("Invalid note");
    }
    if (
      /(?:mShowingLockscreen|isStatusBarKeyguard|showing|mKeyguardShowing)=true/.test(
        await this.bridge.shell("dumpsys", "window", "policy"),
      )
    ) {
      throw new Error("Phone locked");
    }
    const output = await this.bridge.shell(
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `xhsdiscover://item/${identity}?type=normal`,
      "-p",
      "com.xingin.xhs",
    );
    if (/Error:|Exception|unable to resolve/i.test(output)) {
      throw new Error("Cannot open note");
    }
    await sleep(1500);
    await this.foreground();
  }
  async nodes() {
    await this.foreground();
    const xml = z
      .string()
      .max(2000000)
      .parse(await this.bridge.call("dumpWindowHierarchy", false, 50));
    await this.foreground();
    return parsePhoneNodes(xml);
  }
  async texts() {
    return (await this.nodes()).flatMap((node) =>
      [node.text, node["content-desc"]].filter(Boolean),
    );
  }
  async tap(label: string, scroll?: "horizontal" | "vertical") {
    if (label === "提交" && !this.allowSubmit) {
      throw new Error("Submission is disabled in preflight");
    }
    let previous = "";
    for (let count = 0; count < (scroll ? 5 : 1); count++) {
      const nodes = await this.nodes();
      const node = selectPhoneNode(
        nodes,
        label,
        label === "更多" ? "com.xingin.xhs:id/moreOperateIV" : undefined,
      );
      if (node) {
        const box = phoneBounds(node)!;
        await this.foreground();
        await this.bridge.shell(
          "input",
          "tap",
          String(Math.floor((box[0] + box[2]) / 2)),
          String(Math.floor((box[1] + box[3]) / 2)),
        );
        await sleep(400);
        return;
      }
      const signature = JSON.stringify(nodes);
      if (!scroll || signature === previous || count === 4) {
        break;
      }
      previous = signature;
      await this.scroll(nodes, scroll);
    }
    throw new Error("Phone control missing");
  }
  private async scroll(nodes: PhoneNode[], direction: "horizontal" | "vertical") {
    const boxes = nodes
      .map(phoneBounds)
      .filter((box): box is [number, number, number, number] => Boolean(box))
      .toSorted((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
    if (!boxes.length) {
      throw new Error("Unknown screen bounds");
    }
    const [left, top, right, bottom] = boxes[0];
    let points: number[];
    if (direction === "horizontal") {
      if (!nodes.some((node) => node.text === "分享至")) {
        throw new Error("Not a share sheet");
      }
      const row = nodes
        .filter((node) =>
          ["复制链接", "举报", "保存图片", "不喜欢", "生成分享图"].includes(node.text),
        )
        .map(phoneBounds)
        .filter((box): box is [number, number, number, number] => Boolean(box));
      if (!row.length) {
        throw new Error("Missing share row");
      }
      const y = (Math.min(...row.map((b) => b[1])) + Math.max(...row.map((b) => b[3]))) / 2;
      points = [left + (right - left) * 0.9, y, left + (right - left) * 0.1, y];
    } else {
      if (!nodes.some((node) => `${node.text}${node["content-desc"]}`.includes("举报"))) {
        throw new Error("Not a report form");
      }
      points = [
        left + (right - left) * 0.93,
        top + (bottom - top) * 0.85,
        left + (right - left) * 0.93,
        top + (bottom - top) * 0.4,
      ];
    }
    await this.foreground();
    await this.bridge.shell(
      "input",
      "swipe",
      ...points.map((value) => String(Math.floor(value))),
      "500",
    );
    await sleep(400);
  }
  async copiedLink() {
    const clipboard = async () =>
      z
        .string()
        .max(20000)
        .parse((await this.bridge.call("getClipboard")) ?? "");
    const original = await clipboard();
    const sentinel = `openclaw-${randomUUID()}`;
    let copied = sentinel;
    try {
      await this.bridge.call("setClipboard", "OpenClaw", sentinel);
      if ((await clipboard()) !== sentinel) {
        throw new Error("Clipboard not writable");
      }
      await this.tap("复制链接", "horizontal");
      for (let index = 0; index < 5; index++) {
        copied = await clipboard();
        if (copied !== sentinel) {
          break;
        }
        await sleep(300);
      }
    } finally {
      if ([sentinel, copied].includes(await clipboard())) {
        await this.bridge.call("setClipboard", "OpenClaw", original);
      }
    }
    const links = copied.match(/https?:\/\/[^\s<>"，。]+/g);
    if (links?.length !== 1) {
      throw new Error("Missing unique copied link");
    }
    const target = await this.resolveLink(links[0]);
    if (!(await this.texts()).includes("分享至")) {
      await this.tap("更多");
    }
    return target;
  }
  async openReport() {
    await this.tap("举报", "horizontal");
  }
  async selectCategory(category: string, subCategory?: string) {
    if (/^(?:提交|下一步|返回|举报|更多)$/.test(category) || /侵犯我.*权益/.test(category)) {
      throw new Error("Identity material or explicit category required");
    }
    const group = "对他人造成困扰或危害";
    const choose = (wanted: string, labels: string[]) =>
      selectDouyinCategory(wanted, labels) ??
      (wanted === "不实信息" && labels.includes("不实信息、谣言") ? "不实信息、谣言" : undefined);
    let labels = await this.texts();
    if (labels.includes(group) && (!choose(category, labels) || category === group)) {
      await this.tap(group);
      if (category === group) {
        category = subCategory ?? "";
        subCategory = undefined;
      }
      labels = await this.texts();
    }
    const selected = choose(category, labels);
    if (!selected) {
      throw new Error("Unresolved phone category");
    }
    await this.tap(selected, "vertical");
    if ((await this.texts()).includes("下一步")) {
      await this.tap("下一步");
    }
    if (subCategory) {
      const sub = choose(subCategory, await this.texts());
      if (!sub || /^(?:提交|下一步|返回)$/.test(sub)) {
        throw new Error("Unresolved phone subcategory");
      }
      await this.tap(sub, "vertical");
    }
  }
  async fillReason(reason: string) {
    if (!reason.trim() || reason.length > 400) {
      throw new Error("Phone reason must be 1-400 characters");
    }
    let fields = (await this.nodes()).filter((node) => node.class === "android.widget.EditText");
    if (!fields.length) {
      await this.tap("补充更多举报信息", "vertical");
      fields = (await this.nodes()).filter((node) => node.class === "android.widget.EditText");
    }
    if (fields.length !== 1) {
      throw new Error("Ambiguous description field");
    }
    const selector = {
      mask: 0x080010,
      className: "android.widget.EditText",
      packageName: "com.xingin.xhs",
      childOrSibling: [],
      childOrSiblingSelector: [],
    };
    await this.foreground();
    if ((await this.bridge.call("count", selector)) !== 1) {
      throw new Error("Description field changed");
    }
    await this.bridge.call("setText", selector, reason);
    if (
      !(await this.nodes()).some(
        (node) => node.class === "android.widget.EditText" && node.text === reason,
      )
    ) {
      throw new Error("Description was not entered exactly");
    }
    if (/\bmInputShown=true\b/.test(await this.bridge.shell("dumpsys", "input_method"))) {
      await this.foreground();
      await this.bridge.shell("input", "keyevent", "4");
    }
  }
  async checkSubmitReady() {
    if (!selectPhoneNode(await this.nodes(), "提交")) {
      throw new Error("Phone form not ready");
    }
  }
  async screenshot() {
    await this.foreground();
    return this.bridge.run(["exec-out", "screencap", "-p"]);
  }
  async cleanupPreflight(reason: string) {
    const fields = (await this.nodes()).filter((node) => node.class === "android.widget.EditText");
    if (fields.length === 1 && fields[0].text === reason) {
      const selector = {
        mask: 0x080010,
        className: "android.widget.EditText",
        packageName: "com.xingin.xhs",
        childOrSibling: [],
        childOrSiblingSelector: [],
      };
      await this.foreground();
      await this.bridge.call("clearTextField", selector);
      if (
        (await this.nodes()).some((node) => node.class === "android.widget.EditText" && node.text)
      ) {
        throw new Error("Preflight text cleanup unconfirmed");
      }
    }
    if ((await this.texts()).some((text) => text.includes("举报"))) {
      await this.tap("返回");
    }
    if (
      !(await this.nodes()).some(
        (node) => node["resource-id"] === "com.xingin.xhs:id/moreOperateIV",
      )
    ) {
      throw new Error("Return to note unconfirmed");
    }
  }
}
