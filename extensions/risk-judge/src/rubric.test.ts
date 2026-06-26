import { describe, expect, it } from "vitest";
import {
  buildRiskJudgeUserMessage,
  normalizeRiskLevel,
  parseRiskResult,
  RISK_LEVELS,
} from "./rubric.js";

describe("normalizeRiskLevel", () => {
  it("maps each canonical level and common variants", () => {
    expect(normalizeRiskLevel("蓝色预警")).toBe("蓝色预警");
    expect(normalizeRiskLevel("黄色")).toBe("黄色预警");
    expect(normalizeRiskLevel("橙色预警")).toBe("橙色预警");
    expect(normalizeRiskLevel("红色")).toBe("红色预警");
    expect(normalizeRiskLevel("高危舆情")).toBe("高危预警");
  });

  it("returns null for unrecognized text", () => {
    expect(normalizeRiskLevel("无")).toBeNull();
    expect(normalizeRiskLevel("")).toBeNull();
    expect(normalizeRiskLevel(null)).toBeNull();
  });

  it("only emits canonical levels", () => {
    for (const lvl of RISK_LEVELS) {
      expect(normalizeRiskLevel(lvl)).toBe(lvl);
    }
  });
});

describe("parseRiskResult", () => {
  it("parses a clean fenced-json answer", () => {
    const text =
      '```json\n{"risk_level":"橙色预警","report_markdown":"**一、事件概述**\\n……"}\n```';
    const r = parseRiskResult(text);
    expect(r?.riskLevel).toBe("橙色预警");
    expect(r?.reportMarkdown).toContain("事件概述");
  });

  it("parses bare json without fences", () => {
    const r = parseRiskResult('前言{"risk_level":"红色预警","report_markdown":"正文"}后记');
    expect(r?.riskLevel).toBe("红色预警");
    expect(r?.reportMarkdown).toBe("正文");
  });

  it("recovers a level from prose when json is malformed, keeping the body", () => {
    const text = "本次研判结论为蓝色预警，整体态势平稳可控。";
    const r = parseRiskResult(text);
    expect(r?.riskLevel).toBe("蓝色预警");
    expect(r?.reportMarkdown).toContain("态势平稳");
  });

  it("falls back to the whole text when json has a level but no body", () => {
    const r = parseRiskResult('{"risk_level":"黄色预警"}');
    expect(r?.riskLevel).toBe("黄色预警");
    expect(r?.reportMarkdown).toContain("黄色预警");
  });

  it("returns null when no level can be determined", () => {
    expect(parseRiskResult("这是一段没有任何等级判定的普通文本。")).toBeNull();
    expect(parseRiskResult("")).toBeNull();
  });
});

describe("buildRiskJudgeUserMessage", () => {
  it("tags a whitelisted author as hitting 标准①", () => {
    const msg = buildRiskJudgeUserMessage({
      content: "某事件正文",
      author: "人民网",
      authorIsMedia: true,
    });
    expect(msg).toContain("命中权威媒体白名单");
    expect(msg).toContain("某事件正文");
  });

  it("marks a non-media or missing author accordingly", () => {
    const m1 = buildRiskJudgeUserMessage({
      content: "正文",
      author: "某大V",
      authorIsMedia: false,
    });
    expect(m1).toContain("未命中权威媒体白名单");
    const m2 = buildRiskJudgeUserMessage({ content: "正文", authorIsMedia: false });
    expect(m2).toContain("作者：未知");
  });
});
