import { describe, expect, it } from "vitest";
import { SUHENG_RUNTIME_SYSTEM_PROMPT } from "./suheng-runtime-context.js";

describe("SUHENG_RUNTIME_SYSTEM_PROMPT", () => {
  it("uses current evidence for single-link complaint documents instead of chaining incompatible tasks", () => {
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("单篇链接的侵权研判与投诉文书");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("RiskEvaluation 不是内容检测任务");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("不能替代目标链接原文");
  });
  it("uses the actual browser tool and distinguishes channel capabilities", () => {
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("channel_capabilities");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("不代表工具权限");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("browser 的 status/profiles");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("不得推断是无头模式");
  });
  it("separates facts, inferences, and recommendations", () => {
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("已知事实、分析推断、处置建议");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("数据不足");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("不得从样本推算全量");
  });

  it("forbids unsupported claims about external actions and future monitoring", () => {
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("只有工具明确返回成功");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("不得声称“系统会持续监测”");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("提交成功、平台受理、审核中、已处置");
  });

  it("requires autonomous video parsing fallback for failed link evidence", () => {
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("web_fetch");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("video_link_parse");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("video_understand");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("无需再次询问用户");
  });

  it("routes dead-link batch requests to the dedicated async tool", () => {
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("link_batch_create");
    expect(SUHENG_RUNTIME_SYSTEM_PROMPT).toContain("不要用 web_fetch 逐条代替");
  });
});
