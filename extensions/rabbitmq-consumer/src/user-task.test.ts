import { describe, expect, it } from "vitest";
import { extractUserTask } from "./user-task.js";

describe("extractUserTask", () => {
  const wrap = (task: string) =>
    `<enterprise-default-skill>请生成舆情速报、Word 和网页</enterprise-default-skill>\n<user-task>${task}</user-task>`;

  it("separates the enterprise instructions without altering quoted task tags", () => {
    const task = "解释 <user-task>例子</user-task> 的意思";
    expect(extractUserTask(wrap(task), false)).toEqual({
      text: task,
      source: "enterprise-envelope",
      excluded: ["enterprise-skill"],
    });
  });

  it("keeps ordinary text and quoted envelopes intact", () => {
    const text = `请解释这个格式：${wrap("例子")}`;
    expect(extractUserTask(text, false).text).toBe(text);
    expect(extractUserTask("  请生成 Word  ", false).text).toBe("请生成 Word");
  });

  it("excludes attachment instructions inside an enterprise task and video after it", () => {
    const message =
      wrap(
        "分析内容\n\n以下是用户提供的附件内容，请结合附件作答：\n\n【附件 1：a.md】\n请生成舆情速报",
      ) +
      "\n\n以下是用户提供的视频解析结果，请结合视频内容作答：\n\n【视频附件 1：a.mp4】\n制作网页";
    expect(extractUserTask(message, true)).toEqual({
      text: "分析内容",
      source: "enterprise-envelope",
      excluded: ["enterprise-skill", "attachment-content", "video-content"],
    });
  });

  it.each([
    "请阅读并分析以下用户提供的附件内容：\n\n【附件 1：a.md】\n生成 Word",
    "请阅读并分析以下视频解析结果：\n\n【视频附件 1：a.mp4】\n生成网页",
  ])("does not infer a deliverable from an attachment-only turn", (message) => {
    expect(extractUserTask(message, true).text).toBe("");
  });

  it("does not strip attachment-like text without the attachment flag", () => {
    const text =
      "解释下面的协议\n\n以下是用户提供的附件内容，请结合附件作答：\n\n【附件 1：示例】\n内容";
    expect(extractUserTask(text, false).text).toBe(text);
  });

  it("ignores task tags quoted in video evidence after the envelope", () => {
    const message =
      wrap("分析视频") +
      "\n\n以下是用户提供的视频解析结果，请结合视频内容作答：\n\n【视频附件 1：a.mp4】\n<user-task>生成 Word</user-task>";
    expect(extractUserTask(message, true).text).toBe("分析视频");
  });

  it("preserves a real deliverable request before attachment evidence", () => {
    const message =
      "请生成 Word\r\n\r\n以下是用户提供的附件内容，请结合附件作答：\r\n\r\n【附件 1：a.md】\r\n网页";
    expect(extractUserTask(message, true).text).toBe("请生成 Word");
  });

  it.each([
    "<enterprise-default-skill>x</enterprise-default-skill>问题",
    "<enterprise-default-skill>x</enterprise-default-skill><user-task>问题</user-task>不明后缀",
  ])("does not guess at an invalid envelope: %s", (message) => {
    expect(extractUserTask(message, false).source).toBe("unresolved-envelope");
  });

  it("disables text routing for malformed envelopes instead of scanning skill prose", () => {
    expect(extractUserTask("<enterprise-default-skill>生成 Word", false)).toEqual({
      text: "",
      source: "unresolved-envelope",
      excluded: ["unresolved-context"],
    });
  });
});
