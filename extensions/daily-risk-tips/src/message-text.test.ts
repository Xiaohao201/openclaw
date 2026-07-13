import { describe, expect, it } from "vitest";
import { collectAssistantTexts, extractMessageText } from "./message-text.js";

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

describe("collectAssistantTexts", () => {
  it("returns all non-empty assistant texts, most recent first", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "问" },
      { role: "assistant", content: '{"prompt":"规则"}' },
      { role: "assistant", content: "" },
      { role: "assistant", content: "收尾话" },
    ];
    expect(collectAssistantTexts(messages)).toEqual(["收尾话", '{"prompt":"规则"}']);
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
        content: [{ type: "text", text: '{"prompt":"规则内容"}' }],
      },
    ];
    const texts = collectAssistantTexts(messages);
    expect(texts.some((t) => t.includes('"prompt":"规则内容"'))).toBe(true);
  });

  it("returns an empty array when there are no messages", () => {
    expect(collectAssistantTexts([])).toEqual([]);
    expect(collectAssistantTexts(null as unknown as unknown[])).toEqual([]);
  });
});
