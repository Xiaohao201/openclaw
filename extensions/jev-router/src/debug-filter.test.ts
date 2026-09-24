import { describe, expect, it, vi } from "vitest";
import { filterDebugRequest } from "./debug-filter.js";

const tool = (name: string) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object" } },
});
const messages = [
  { role: "user", content: "[JEV_SYNTHETIC_BENCH] Read the file mentioned earlier" },
  { role: "assistant", content: "The path is sample.txt" },
];
describe("debug request filtering", () => {
  it("passes full conversation as state and preserves original messages and schemas", async () => {
    const decide = vi
      .fn()
      .mockResolvedValue({ status: "selected", candidates: ["read"], elapsedMs: 2 });
    const input = {
      messages,
      tools: [tool("web_search"), tool("read"), tool("exec")],
      model: "test",
      stream: true,
    };
    const result = await filterDebugRequest(input, decide);
    expect(result.body.messages).toBe(messages);
    expect(result.body.tools).toEqual([input.tools[1]]);
    expect(decide.mock.calls[0][0]).toContain("sample.txt");
    expect(input.tools).toHaveLength(3);
  });
  it("leaves unmarked, forced-tool, unsupported, and abstained requests unchanged", async () => {
    const decide = vi
      .fn()
      .mockResolvedValue({ status: "abstain", candidates: [], reason: "timeout", elapsedMs: 2 });
    for (const body of [
      { messages: [], tools: [tool("read")] },
      { messages, tools: [tool("read")], tool_choice: "required" },
      { messages, tools: [tool("exec")] },
    ]) {
      expect((await filterDebugRequest(body, decide)).body).toBe(body);
    }
    expect(decide).not.toHaveBeenCalled();
    const body = { messages, tools: [tool("read")] };
    expect((await filterDebugRequest(body, decide)).body).toBe(body);
  });
  it("cannot introduce tools and handles no-tools without an empty allowlist ambiguity", async () => {
    const body = { messages, tools: [tool("read")], tool_choice: "auto" };
    expect(
      (
        await filterDebugRequest(body, async () => ({
          status: "selected",
          candidates: ["web_search"],
          confidence: 1,
          elapsedMs: 1,
        }))
      ).body,
    ).toBe(body);
    const result = await filterDebugRequest(body, async () => ({
      status: "no_tools",
      candidates: [],
      confidence: 1,
      elapsedMs: 1,
    }));
    expect(result.body.tools).toBeUndefined();
    expect(result.body.tool_choice).toBeUndefined();
    expect(result.body.messages).toBe(messages);
  });
  it("keeps request assembly deterministic and tool-result history intact across turns", async () => {
    const decide = vi
      .fn()
      .mockResolvedValue({ status: "selected", candidates: ["read"], confidence: 1, elapsedMs: 1 });
    const body = {
      messages: [...messages, { role: "tool", content: "next.txt", tool_call_id: "call1" }],
      tools: [tool("read"), tool("web_search")],
    };
    const a = await filterDebugRequest(body, decide);
    const b = await filterDebugRequest(body, decide);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(a.body.messages).toBe(body.messages);
    expect(decide.mock.calls[0][0]).toBe(decide.mock.calls[1][0]);
    expect(decide.mock.calls[0][0]).toContain("next.txt");
  });
});
