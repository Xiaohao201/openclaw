import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { createDailyRiskTipsToolFactory } from "./daily-risk-tips-tool.js";

type RunParams = { sessionKey: string; message: string; extraSystemPrompt: string };
type WaitParams = { runId: string; timeoutMs?: number };
type GetSessionMessagesParams = { sessionKey: string; limit?: number };

function buildFakeSubagent(sessionsByKeySuffix: Record<string, unknown[]>) {
  return {
    run: vi.fn(async (params: RunParams) => ({ runId: `run-${params.sessionKey}` })),
    waitForRun: vi.fn(
      async (
        _params: WaitParams,
      ): Promise<{ status: "ok" | "error" | "timeout"; error?: string }> => ({ status: "ok" }),
    ),
    getSessionMessages: vi.fn(async (params: GetSessionMessagesParams) => {
      const suffix = params.sessionKey.endsWith(":style") ? "style" : "generate";
      return { messages: sessionsByKeySuffix[suffix] ?? [] };
    }),
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

const STYLE_ANSWER = '```json\n{"prompt":"写作规则：标题加粗动宾结构，正文150字以内"}\n```';
const GENERATED_ANSWER =
  "**加强执行落差防范**。某政策发布后需警惕基层配套滞后，建议相关部门加强政策解读。";

describe("daily_risk_tips tool", () => {
  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.plugin.gatewaySubagentRuntime")
    ];
  });

  it("runs the retrieval+style turn then the generation turn and returns the cleaned tip", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: STYLE_ANSWER }],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { message: "某政策发布" });

    expect(result.details).toMatchObject({ success: true, daily_risk_tip: GENERATED_ANSWER });
    expect(subagent.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("passes the extracted style rules as turn B's system prompt", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: STYLE_ANSWER }],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "某政策发布" });

    const generateCall = subagent.run.mock.calls.find((call) =>
      call[0].sessionKey.endsWith(":generate"),
    );
    expect(generateCall?.[0].extraSystemPrompt).toBe("写作规则：标题加粗动宾结构，正文150字以内");
  });

  it("includes retrieval params (collection/embeddingProfile/topK) in turn A's user message", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: STYLE_ANSWER }],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi(
      { sourceCollection: "DailyRiskTips", embeddingProfile: "doubao", topK: 7 },
      subagent,
    );
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "某政策发布" });

    const styleCall = subagent.run.mock.calls.find((call) => call[0].sessionKey.endsWith(":style"));
    expect(styleCall?.[0].message).toContain('collection: "DailyRiskTips"');
    expect(styleCall?.[0].message).toContain('embeddingProfile: "doubao"');
    expect(styleCall?.[0].message).toContain("topK: 7");
  });

  it("falls back to a default style prompt when turn A produces no usable style rules", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: "没有可用的json内容也没有等级判定" }],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { message: "某政策发布" });

    // extractStyleRules falls back to the cleaned raw text itself for unparsable prose,
    // so turn B still receives *something* non-empty as its system prompt, and the tool succeeds.
    expect(result.details).toMatchObject({ success: true });
  });

  it("finds the style JSON even when a later assistant message in turn A is a closing remark", async () => {
    const subagent = buildFakeSubagent({
      style: [
        { role: "assistant", content: [{ type: "tool_use", name: "milvus_search", input: {} }] },
        { role: "tool", content: "[]" },
        { role: "assistant", content: STYLE_ANSWER },
        { role: "assistant", content: "已完成检索与规则提炼。" },
      ],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "某政策发布" });

    const generateCall = subagent.run.mock.calls.find((call) =>
      call[0].sessionKey.endsWith(":generate"),
    );
    expect(generateCall?.[0].extraSystemPrompt).toBe("写作规则：标题加粗动宾结构，正文150字以内");
  });

  it("still generates a tip when turn A times out, instead of failing the whole tool", async () => {
    const subagent = buildFakeSubagent({
      style: [],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    subagent.waitForRun.mockResolvedValueOnce({ status: "timeout" });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { message: "某政策发布" });

    expect(result.details).toMatchObject({ success: true, daily_risk_tip: GENERATED_ANSWER });
    expect(subagent.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("gives turn A its own shorter budget and turn B the full timeout", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: STYLE_ANSWER }],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({ timeoutMs: 120_000, styleTimeoutMs: 30_000 }, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "某政策发布" });

    expect(subagent.waitForRun.mock.calls[0][0].timeoutMs).toBe(30_000);
    expect(subagent.waitForRun.mock.calls[1][0].timeoutMs).toBe(120_000);
  });

  it("skips the retrieval turn on later calls once it has failed (cooldown)", async () => {
    const subagent = buildFakeSubagent({
      style: [],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "某政策发布" });
    subagent.run.mockClear();
    const second = await tool.execute("call-2", { message: "另一个政策" });

    expect(second.details).toMatchObject({ success: true, daily_risk_tip: GENERATED_ANSWER });
    expect(subagent.run).toHaveBeenCalledTimes(1);
    expect(subagent.run.mock.calls[0][0].sessionKey.endsWith(":generate")).toBe(true);
  });

  it("keeps retrying the retrieval turn when the cooldown is disabled", async () => {
    const subagent = buildFakeSubagent({
      style: [],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({ retrievalCooldownMs: 0 }, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "某政策发布" });
    subagent.run.mockClear();
    await tool.execute("call-2", { message: "另一个政策" });

    expect(subagent.run).toHaveBeenCalledTimes(2);
  });

  it("returns a failure when turn B produces no assistant text", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: STYLE_ANSWER }],
      generate: [],
    });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", { message: "某政策发布" });

    expect(result.details).toMatchObject({ success: false });
  });

  it("rejects a missing message param without touching the subagent", async () => {
    const subagent = buildFakeSubagent({ style: [], generate: [] });
    const api = buildFakeApi({}, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    const result = await tool.execute("call-1", {});

    expect(result.details).toMatchObject({ success: false });
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("truncates an overlong message to queryMaxChars before using it as the retrieval query", async () => {
    const subagent = buildFakeSubagent({
      style: [{ role: "assistant", content: STYLE_ANSWER }],
      generate: [{ role: "assistant", content: GENERATED_ANSWER }],
    });
    const api = buildFakeApi({ queryMaxChars: 5 }, subagent);
    const tool = createDailyRiskTipsToolFactory(api)({ agentId: "agent1", sessionId: "s1" });

    await tool.execute("call-1", { message: "一二三四五六七八九十" });

    const styleCall = subagent.run.mock.calls.find((call) => call[0].sessionKey.endsWith(":style"));
    expect(styleCall?.[0].message).toContain('query: "一二三四五"');
  });
});
