import { describe, expect, it } from "vitest";
import { collectAssistantTexts, extractAssistantText, extractMessageText } from "./message-text.js";

describe("extractMessageText", () => {
  it("returns a string content as-is", () => {
    expect(extractMessageText("hello")).toBe("hello");
  });

  it("flattens block-array content", () => {
    expect(
      extractMessageText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("ignores non-text blocks", () => {
    expect(extractMessageText([{ type: "tool_use", name: "milvus_search" }, "tail"])).toBe("tail");
  });
});

describe("extractAssistantText", () => {
  it("returns the most recent assistant message's text", () => {
    const messages = [
      { role: "user", content: "问" },
      { role: "assistant", content: "第一条" },
      { role: "assistant", content: "第二条" },
    ];
    expect(extractAssistantText(messages)).toBe("第二条");
  });

  it("returns an empty string when no assistant text exists", () => {
    expect(extractAssistantText([{ role: "user", content: "问" }])).toBe("");
    expect(extractAssistantText([])).toBe("");
  });
});

describe("collectAssistantTexts", () => {
  it("returns all non-empty assistant texts, most recent first", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "问" },
      { role: "assistant", content: '{"risk_level":"黄色预警","report_markdown":"正文"}' },
      { role: "assistant", content: "" },
      { role: "assistant", content: "收尾话" },
    ];
    expect(collectAssistantTexts(messages)).toEqual([
      "收尾话",
      '{"risk_level":"黄色预警","report_markdown":"正文"}',
    ]);
  });

  it("handles a tool-using turn where the json answer is not the last assistant message", () => {
    const messages = [
      { role: "user", content: "问" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "milvus_search", input: { query: "x" } }],
      },
      { role: "tool", content: "[]" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '```json\n{"risk_level":"蓝色预警","report_markdown":"正文"}\n```',
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "milvus_upsert", input: { entries: [] } }],
      },
      { role: "tool", content: '{"success":true}' },
      { role: "assistant", content: "已记录本次案例。" },
    ];
    const texts = collectAssistantTexts(messages);
    expect(texts[0]).toBe("已记录本次案例。");
    expect(texts.some((t) => t.includes('"risk_level":"蓝色预警"'))).toBe(true);
  });

  it("returns an empty array when there are no messages", () => {
    expect(collectAssistantTexts([])).toEqual([]);
    expect(collectAssistantTexts(null as unknown as unknown[])).toEqual([]);
  });
});
