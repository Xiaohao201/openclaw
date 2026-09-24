import { describe, expect, it, vi } from "vitest";
import { parseTaskDataset, runTask, summarizePairs } from "./benchmark.js";
import { parseUsage } from "./usage.js";

const task = () =>
  parseTaskDataset([
    {
      id: "read-code",
      prompt: "Read ./code.txt and report the code.",
      candidates: ["read", "web_search"],
      fixtures: [{ tool: "read", args: { path: "./code.txt" }, result: "Code: ECHO-7391" }],
      requiredTools: ["read"],
      answerContains: ["ECHO-7391"],
    },
  ])[0];
const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.001, cachedTokens: 0 };
const selected = {
  status: "selected" as const,
  candidates: ["read" as const],
  confidence: 0.9,
  elapsedMs: 15,
  usage,
};
function model() {
  return vi
    .fn()
    .mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"./code.txt"}' },
          },
        ],
      },
      usage,
    })
    .mockResolvedValueOnce({ message: { role: "assistant", content: "ECHO-7391" }, usage });
}

describe("controlled task benchmark", () => {
  it("completes a baseline task through tool results and accounts for every call", async () => {
    const complete = model();
    const decide = vi.fn();
    const result = await runTask(task(), "baseline", { complete, decide });
    expect(result).toMatchObject({
      success: true,
      modelCalls: 2,
      toolCalls: 1,
      decisionCalls: 0,
      costUsd: 0.002,
      inputTokens: 200,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(complete.mock.calls[1][0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Code: ECHO-7391",
    });
    expect(JSON.stringify(result)).not.toContain("ECHO-7391");
  });
  it("uses the actual advisory hook while preserving tool schemas and the system prefix", async () => {
    const baseline = model();
    const advisory = model();
    const decide = vi.fn().mockResolvedValue(selected);
    await runTask(task(), "baseline", { complete: baseline, decide });
    const result = await runTask(task(), "advisory", { complete: advisory, decide });
    expect(result).toMatchObject({ success: true, decisionCalls: 1, costUsd: 0.003 });
    expect(advisory.mock.calls[0][0].tools).toEqual(baseline.mock.calls[0][0].tools);
    expect(advisory.mock.calls[0][0].messages[0]).toEqual(baseline.mock.calls[0][0].messages[0]);
    expect(advisory.mock.calls[0][0].messages[1].content).toContain("Read-only tool shortlist");
    expect(advisory.mock.calls[1][0].messages.slice(0, 2)).toEqual(
      advisory.mock.calls[0][0].messages.slice(0, 2),
    );
  });
  it("does not allow correct-looking final text to hide missing required tool calls", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue({ message: { role: "assistant", content: "ECHO-7391" }, usage });
    expect(await runTask(task(), "baseline", { complete, decide: vi.fn() })).toMatchObject({
      success: false,
      reason: "wrong_answer",
    });
  });
  it("rejects unauthorized tools and invalid arguments without executing anything", async () => {
    for (const [name, args] of [
      ["exec", '{"command":"dir"}'],
      ["read", '{"path":"../../secret"}'],
      ["read", "not-json"],
    ]) {
      const complete = vi.fn().mockResolvedValue({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "bad", type: "function", function: { name, arguments: args } }],
        },
        usage,
      });
      expect(await runTask(task(), "baseline", { complete, decide: vi.fn() })).toMatchObject({
        success: false,
        reason: "invalid_tool_call",
        toolCalls: 0,
      });
    }
  });
  it("enforces the model-call budget and counts unsuccessful tasks", async () => {
    const complete = vi.fn().mockImplementation(async () => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "repeat",
            type: "function",
            function: { name: "read", arguments: '{"path":"./code.txt"}' },
          },
        ],
      },
      usage,
    }));
    expect(await runTask(task(), "baseline", { complete, decide: vi.fn() }, 2)).toMatchObject({
      success: false,
      reason: "step_limit",
      modelCalls: 2,
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("keeps unknown billing unknown and handles transport failure", async () => {
    const complete = model();
    const decide = vi.fn().mockResolvedValue({ ...selected, usage: undefined });
    expect(await runTask(task(), "advisory", { complete, decide })).toMatchObject({
      costUsd: null,
    });
    expect(
      await runTask(task(), "baseline", {
        complete: vi.fn().mockRejectedValue(new Error("private")),
        decide,
      }),
    ).toMatchObject({ success: false, reason: "model_error", costUsd: null });
  });
  it("requires complete matching pairs instead of dropping unsuccessful arms", async () => {
    const first = await runTask(task(), "baseline", { complete: model(), decide: vi.fn() });
    const second = { ...first, arm: "advisory" as const, success: false, costUsd: null };
    expect(summarizePairs([first, second])).toMatchObject({
      pairs: 1,
      baselineSuccessRate: 1,
      advisorySuccessRate: 0,
      totalCostDeltaUsd: null,
    });
    expect(() => summarizePairs([first])).toThrow();
    expect(() => summarizePairs([first, first, second])).toThrow();
  });
  it("validates task fixtures and rejects unsupported or inconsistent labels", () => {
    expect(() => parseTaskDataset([{ ...task(), candidates: ["exec"] }])).toThrow();
    expect(() => parseTaskDataset([{ ...task(), requiredTools: ["memory_get"] }])).toThrow();
    expect(() => parseTaskDataset([task(), task()])).toThrow();
  });
});

describe("upstream usage accounting", () => {
  it("accepts normalized decision/chat usage without treating absent billing as free", () => {
    expect(
      parseUsage({
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          cost: 0.0002,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 3, costUsd: 0.0002, cachedTokens: 4 });
    expect(parseUsage({ usage: { input_tokens: 12, output_tokens: 3 } })).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsd: null,
      cachedTokens: null,
    });
    expect(parseUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      cachedTokens: null,
    });
    expect(parseUsage({ usage: { cost: -1 } }).costUsd).toBeNull();
  });
});
