import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import { classifyReportIntent, type ReportIntentSubagent } from "./report-intent-llm.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as PluginLogger;

/** Build a subagent mock whose run resolves to the given assistant text. */
function subagentReturning(
  assistantText: string | null,
  overrides: Partial<{
    waitStatus: "ok" | "error" | "timeout";
    runThrows: boolean;
    captureRun: (args: Record<string, unknown>) => void;
  }> = {},
) {
  const messages =
    assistantText === null
      ? [{ role: "user", content: "x" }]
      : [
          { role: "user", content: "x" },
          { role: "assistant", content: assistantText },
        ];
  return {
    run: vi.fn(async (args: Record<string, unknown>) => {
      overrides.captureRun?.(args);
      if (overrides.runThrows) {
        throw new Error("run boom");
      }
      return { runId: "run-1" };
    }),
    waitForRun: vi.fn(async () => ({ status: overrides.waitStatus ?? ("ok" as const) })),
    getSessionMessages: vi.fn(async () => ({ messages })),
    deleteSession: vi.fn(async () => {}),
  };
}

const base = {
  instruction: "月报的统计口径是不是变了？",
  hintedPeriod: "月报" as const,
  userId: "2059",
  token: 2001,
  logger,
};

describe("classifyReportIntent", () => {
  it("accepts a positive verdict and its period", async () => {
    const subagent = subagentReturning('{"isReport": true, "period": "周报"}');
    const verdict = await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: true, period: "周报" });
  });

  it("falls back to the hinted period when the model omits one", async () => {
    const subagent = subagentReturning('{"isReport": true, "period": null}');
    const verdict = await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: true, period: "月报" });
  });

  it("returns a negative verdict for a meta-question", async () => {
    const subagent = subagentReturning('{"isReport": false, "period": null}');
    const verdict = await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: false, period: null });
  });

  it("parses JSON wrapped in prose or a code fence", async () => {
    const subagent = subagentReturning('```json\n{"isReport": true, "period": "日报"}\n```');
    const verdict = await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: true, period: "日报" });
  });

  it.each([
    ["a timeout", { waitStatus: "timeout" as const }],
    ["a run error", { waitStatus: "error" as const }],
    ["a thrown run", { runThrows: true }],
  ])("fails closed on %s", async (_label, overrides) => {
    const subagent = subagentReturning('{"isReport": true, "period": "周报"}', overrides);
    const verdict = await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: false, period: null });
  });

  it("fails closed on an unparseable reply", async () => {
    const subagent = subagentReturning("我觉得应该是周报吧");
    const verdict = await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: false, period: null });
  });

  it("skips the model entirely for an empty instruction", async () => {
    const subagent = subagentReturning('{"isReport": true, "period": "周报"}');
    const verdict = await classifyReportIntent({
      ...base,
      instruction: "   ",
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(verdict).toEqual({ isReport: false, period: null });
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("runs isolated: no delivery, own session, torn down after", async () => {
    let captured: Record<string, unknown> = {};
    const subagent = subagentReturning('{"isReport": false, "period": null}', {
      captureRun: (args) => {
        captured = args;
      },
    });
    await classifyReportIntent({
      ...base,
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(captured.deliver).toBe(false);
    expect(captured.sessionKey).toBe("agent:rabbitmq-2059:report-intent:2059:2001");
    expect(subagent.deleteSession).toHaveBeenCalledWith({
      sessionKey: "agent:rabbitmq-2059:report-intent:2059:2001",
      deleteTranscript: true,
    });
  });

  it("never sends the pasted body — only the instruction slice", async () => {
    let captured: Record<string, unknown> = {};
    const subagent = subagentReturning('{"isReport": false, "period": null}', {
      captureRun: (args) => {
        captured = args;
      },
    });
    await classifyReportIntent({
      ...base,
      instruction: "请撰写四、2026年8月深圳市市监舆情风险前瞻与应对建议",
      subagent: subagent as unknown as ReportIntentSubagent,
    });
    expect(String(captured.message)).toContain("撰写四、2026年8月深圳市市监舆情风险前瞻");
    expect(String(captured.message)).not.toContain("时代周报、深圳新闻网");
  });
});
