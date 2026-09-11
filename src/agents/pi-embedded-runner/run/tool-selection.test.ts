import { describe, expect, it } from "vitest";
import { createRunToolSelection } from "./tool-selection.js";

const tools = [
  "daily_risk_tips",
  "milvus_search",
  "feed_query",
  "full_text_search",
  "mcp_lookup",
  "lsp_lookup",
].map((name) => ({ name }));
const clientTools = [{ function: { name: "client_lookup" } }];

describe("per-run tool selection", () => {
  it("disables every tool source even when a tool is explicitly allowed", () => {
    const selection = createRunToolSelection({
      modelSupportsTools: true,
      disableTools: true,
      toolsAllow: ["milvus_search", "client_lookup"],
    });
    expect(selection.enabled).toBe(false);
    expect(selection.filter(tools, (tool) => tool.name)).toEqual([]);
    expect(selection.filter(clientTools, (tool) => tool.function.name)).toEqual([]);
  });
  it("limits retrieval across built-in, plugin and client tool sources", () => {
    const selection = createRunToolSelection({
      modelSupportsTools: true,
      toolsAllow: ["milvus_search"],
    });
    expect(selection.filter(tools, (tool) => tool.name)).toEqual([{ name: "milvus_search" }]);
    expect(selection.filter(clientTools, (tool) => tool.function.name)).toEqual([]);
  });
  it.each([undefined, []])("preserves normal policy for toolsAllow=%j", (toolsAllow) => {
    const selection = createRunToolSelection({ modelSupportsTools: true, toolsAllow });
    expect(selection.filter(tools, (tool) => tool.name)).toBe(tools);
    expect(selection.filter(clientTools, (tool) => tool.function.name)).toBe(clientTools);
  });
  it("does not change the parent or subsequent run's tools", () => {
    const before = tools.map((tool) => ({ ...tool }));
    createRunToolSelection({ modelSupportsTools: true, disableTools: true }).filter(
      tools,
      (tool) => tool.name,
    );
    expect(tools).toEqual(before);
    expect(
      createRunToolSelection({ modelSupportsTools: true }).filter(tools, (tool) => tool.name),
    ).toEqual(before);
  });
  it("cannot grant absent tools or enable an unsupported model", () => {
    const selection = createRunToolSelection({
      modelSupportsTools: false,
      toolsAllow: ["missing"],
    });
    expect(selection.enabled).toBe(false);
    expect(selection.filter(tools, (tool) => tool.name)).toEqual([]);
    expect(
      createRunToolSelection({ modelSupportsTools: true, toolsAllow: ["missing"] }).filter(
        tools,
        (tool) => tool.name,
      ),
    ).toEqual([]);
  });
});
