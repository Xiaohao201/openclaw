import { describe, expect, it } from "vitest";
import {
  buildGenerationUserMessage,
  buildStyleExtractionUserMessage,
  extractStyleRules,
  STYLE_EXTRACTION_SYSTEM_PROMPT,
  stripLayout,
  tryExtractJsonStyleRules,
} from "./prompts.js";

describe("STYLE_EXTRACTION_SYSTEM_PROMPT", () => {
  it("asks for a JSON object with a prompt field", () => {
    expect(STYLE_EXTRACTION_SYSTEM_PROMPT).toContain('"prompt": "string"');
  });
});

describe("buildStyleExtractionUserMessage", () => {
  it("instructs the model to call milvus_search with the given retrieval params", () => {
    const msg = buildStyleExtractionUserMessage({
      query: "某政策发布",
      collection: "DailyRiskTips",
      embeddingProfile: "doubao",
      topK: 10,
    });
    expect(msg).toContain("milvus_search");
    expect(msg).toContain('collection: "DailyRiskTips"');
    expect(msg).toContain('embeddingProfile: "doubao"');
    expect(msg).toContain('query: "某政策发布"');
    expect(msg).toContain("topK: 10");
    expect(msg).toContain("每日风险提示案例");
  });

  it("forbids fallback tool use so a failed retrieval goes straight to the JSON answer", () => {
    const msg = buildStyleExtractionUserMessage({
      query: "某政策发布",
      collection: "DailyRiskTips",
      embeddingProfile: "doubao",
      topK: 10,
    });
    expect(msg).toContain("<检索失败兜底>");
    expect(msg).toContain("只允许调用 milvus_search 这一个工具");
    expect(msg).toContain("禁止重试 milvus_search");
    expect(msg).toContain("禁止去读取本地文件");
  });
});

describe("buildGenerationUserMessage", () => {
  it("embeds the background info and requirement", () => {
    const msg = buildGenerationUserMessage({ message: "背景信息文本", requirement: "特殊关注点" });
    expect(msg).toContain("<背景信息>\n背景信息文本\n</背景信息>");
    expect(msg).toContain("<特殊要求>\n特殊关注点\n</特殊要求>");
  });

  it("leaves the requirement block empty when none is given", () => {
    const msg = buildGenerationUserMessage({ message: "背景信息文本" });
    expect(msg).toContain("<特殊要求>\n\n</特殊要求>");
  });

  it("carries the key formatting constraints from the original prompt", () => {
    const msg = buildGenerationUserMessage({ message: "x" });
    expect(msg).toContain("150字以内");
    expect(msg).toContain('全文禁止使用"深圳"或"我市"');
    expect(msg).toContain("建议相关部门");
  });
});

describe("extractStyleRules", () => {
  it("extracts the prompt field from clean JSON", () => {
    expect(extractStyleRules('{"prompt":"写作规则内容"}')).toBe("写作规则内容");
  });

  it("extracts the prompt field from a fenced json block", () => {
    expect(extractStyleRules('```json\n{"prompt":"写作规则内容"}\n```')).toBe("写作规则内容");
  });

  it("falls back to the cleaned text when JSON parsing fails", () => {
    expect(extractStyleRules("这不是JSON")).toBe("这不是JSON");
  });

  it("returns an empty string for empty input", () => {
    expect(extractStyleRules("")).toBe("");
  });

  it("returns an empty string when the JSON has no prompt field", () => {
    expect(extractStyleRules('{"other":"x"}')).toBe("");
  });
});

describe("tryExtractJsonStyleRules", () => {
  it("returns the prompt field from clean JSON", () => {
    expect(tryExtractJsonStyleRules('{"prompt":"写作规则内容"}')).toBe("写作规则内容");
  });

  it("returns null for unparsable prose, unlike extractStyleRules", () => {
    expect(tryExtractJsonStyleRules("已完成检索与规则提炼。")).toBeNull();
    expect(extractStyleRules("已完成检索与规则提炼。")).toBe("已完成检索与规则提炼。");
  });

  it("returns null when the JSON has no usable prompt field", () => {
    expect(tryExtractJsonStyleRules('{"other":"x"}')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(tryExtractJsonStyleRules("")).toBeNull();
  });
});

describe("stripLayout", () => {
  it("removes newlines and collapses double spaces", () => {
    expect(stripLayout("**标题**。\n背景事实  风险推演  建议措施")).toBe(
      "**标题**。背景事实风险推演建议措施",
    );
  });
});
