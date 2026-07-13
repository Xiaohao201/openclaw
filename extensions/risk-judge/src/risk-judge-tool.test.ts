import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { createRiskJudgeToolFactory } from "./risk-judge-tool.js";

function buildFakeSubagent(sessionMessages: unknown[]) {
  return {
    run: vi.fn(async (_params: { sessionKey: string; extraSystemPrompt: string }) => ({
      runId: "run-1",
    })),
    waitForRun: vi.fn(async (_params: { runId: string; timeoutMs?: number }) => ({
      status: "ok" as const,
    })),
    getSessionMessages: vi.fn(async (_params: { sessionKey: string; limit?: number }) => ({
      messages: sessionMessages,
    })),
    getSession: vi.fn(),
    deleteSession: vi.fn(async (_params: { sessionKey: string }) => {}),
  };
}

function buildFakeApi(pluginConfig: Record<string, unknown>, subagent: unknown) {
  return {
    pluginConfig,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    runtime: { subagent },
  } as unknown as OpenClawPluginApi;
}

const JSON_ANSWER = '```json\n{"risk_level":"黄色预警","report_markdown":"研判正文"}\n```';

describe("risk_judge tool", () => {
  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.plugin.gatewaySubagentRuntime")
    ];
  });

  it("parses the answer when it is the only assistant message", async () => {
    const subagent = buildFakeSubagent([
      { role: "user", content: "问" },
      { role: "assistant", content: JSON_ANSWER },
    ]);
    const api = buildFakeApi({}, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { content: "某舆情内容" });

    expect(result.details).toMatchObject({
      success: true,
      risk_level: "黄色预警",
      report_markdown: "研判正文",
      author_is_media: false,
    });
    expect(subagent.deleteSession).toHaveBeenCalled();
  });

  it("finds the json answer even when a later assistant message is a closing remark", async () => {
    // Simulates a tool-using turn: search -> json answer -> upsert -> closing remark.
    const subagent = buildFakeSubagent([
      { role: "user", content: "问" },
      { role: "assistant", content: [{ type: "tool_use", name: "milvus_search", input: {} }] },
      { role: "tool", content: "[]" },
      { role: "assistant", content: JSON_ANSWER },
      { role: "assistant", content: [{ type: "tool_use", name: "milvus_upsert", input: {} }] },
      { role: "tool", content: '{"success":true}' },
      { role: "assistant", content: "已记录本次案例。" },
    ]);
    const api = buildFakeApi({ enablePrecedentRag: true }, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { content: "某舆情内容" });

    expect(result.details).toMatchObject({ success: true, risk_level: "黄色预警" });
  });

  it("requests a large enough session-message window to cover a tool-call round trip", async () => {
    const subagent = buildFakeSubagent([{ role: "assistant", content: JSON_ANSWER }]);
    const api = buildFakeApi({}, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { content: "某舆情内容" });

    expect(subagent.getSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expect.any(Number) }),
    );
    const limit = subagent.getSessionMessages.mock.calls[0][0].limit as number;
    expect(limit).toBeGreaterThanOrEqual(20);
  });

  it("omits milvus RAG instructions from the system prompt when disabled (default)", async () => {
    const subagent = buildFakeSubagent([{ role: "assistant", content: JSON_ANSWER }]);
    const api = buildFakeApi({}, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { content: "某舆情内容" });

    const runArgs = subagent.run.mock.calls[0][0];
    expect(runArgs.extraSystemPrompt).not.toContain("milvus_search");
  });

  it("includes a per-agent milvus collection name in the system prompt when RAG is enabled", async () => {
    const subagent = buildFakeSubagent([{ role: "assistant", content: JSON_ANSWER }]);
    const api = buildFakeApi({ enablePrecedentRag: true }, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent-1", sessionId: "s1" });

    await tool.execute("call-1", { content: "某舆情内容" });

    const runArgs = subagent.run.mock.calls[0][0];
    expect(runArgs.extraSystemPrompt).toContain("milvus_search");
    expect(runArgs.extraSystemPrompt).toContain("risk_judge_cases_agent_1");
  });

  it("still succeeds when RAG is enabled but the model never calls the milvus tools", async () => {
    const subagent = buildFakeSubagent([{ role: "assistant", content: JSON_ANSWER }]);
    const api = buildFakeApi({ enablePrecedentRag: true }, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { content: "某舆情内容" });

    expect(result.details).toMatchObject({ success: true, risk_level: "黄色预警" });
  });

  it("returns a failure result and still cleans up the session when nothing parses", async () => {
    const subagent = buildFakeSubagent([{ role: "assistant", content: "没有等级的闲聊" }]);
    const api = buildFakeApi({}, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { content: "某舆情内容" });

    expect(result.details).toMatchObject({ success: false });
    expect(subagent.deleteSession).toHaveBeenCalled();
  });

  it("cleans up the session even when waitForRun throws", async () => {
    const subagent = buildFakeSubagent([]);
    subagent.waitForRun.mockRejectedValueOnce(new Error("boom"));
    const api = buildFakeApi({}, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { content: "某舆情内容" });

    expect(result.details).toMatchObject({ success: false });
    expect(subagent.deleteSession).toHaveBeenCalled();
  });

  it("rejects a missing content param without touching the subagent", async () => {
    const subagent = buildFakeSubagent([]);
    const api = buildFakeApi({}, subagent);
    const tool = createRiskJudgeToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", {});

    expect(result.details).toMatchObject({ success: false });
    expect(subagent.run).not.toHaveBeenCalled();
  });
});
