import { describe, expect, it } from "vitest";
import { buildSuhengDesignContext, shouldInjectSuhengDesign } from "./suheng-design-context.js";

describe("Suheng design context", () => {
  it.each([
    "请按照夙衡设计规范制作一个舆情分析网页",
    "帮我设计一个可交互的舆情大屏",
    "生成一份带图表的 HTML 风险看板",
    "Create a responsive public-opinion dashboard",
  ])("detects visual artifact creation requests: %s", (message) => {
    expect(shouldInjectSuhengDesign(message)).toBe(true);
  });

  it.each([
    "帮我生成本周舆情报告",
    "Build a concise research guide",
    "分析这个网站的设计有什么问题",
    "查询今天有哪些高风险事件",
    "总结附件中的表格数据",
  ])("does not affect ordinary analysis turns: %s", (message) => {
    expect(shouldInjectSuhengDesign(message)).toBe(false);
  });

  it("builds a compact deterministic prompt compatible with ai-assistant", () => {
    const context = buildSuhengDesignContext("请设计一个舆情分析网页");

    expect(context).toContain("[suheng-design]");
    expect(context).toContain("OpenKnot");
    expect(context).toContain("GFM Markdown");
    expect(context).toContain("standalone HTML");
    expect(context).toContain("JavaScript, iframe, Mermaid, or ECharts");
    expect(context.length).toBeLessThan(3_000);
    expect(buildSuhengDesignContext("请设计一个舆情分析网页")).toBe(context);
  });

  it("returns no context when the request is unrelated", () => {
    expect(buildSuhengDesignContext("帮我分析今天的舆情")).toBe("");
  });
});
