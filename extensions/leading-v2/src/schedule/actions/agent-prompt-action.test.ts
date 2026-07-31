import { afterEach, describe, expect, it, vi } from "vitest";

const { mockCollectTurnUsage, mockInsertHistoryRow } = vi.hoisted(() => ({
  mockCollectTurnUsage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockInsertHistoryRow: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("../../notify/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notify/usage.js")>()),
  collectTurnUsage: mockCollectTurnUsage,
}));

vi.mock("../../notify/history-row.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notify/history-row.js")>()),
  insertHistoryRow: mockInsertHistoryRow,
}));

import type { PluginLogger } from "../../../api.js";
import type { TurnUsageRecord } from "../../notify/usage.js";
import type { ScheduledTask } from "../types.js";
import { agentPromptAction } from "./agent-prompt-action.js";
import type { ActionRunnerDeps } from "./types.js";

const usagePolicy = { currency: "CNY", rate: 7, foreignProviders: ["minimax"] };

const usage: TurnUsageRecord = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 1540,
  inputCost: 0.0036,
  outputCost: 0.00408,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  totalCost: 0.00768,
  currency: "CNY",
  provider: "qwen",
  model: "qwen3.6-plus",
  calls: 4,
  detail: {},
};

afterEach(() => vi.clearAllMocks());

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as PluginLogger;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    uid: "1749",
    title: "每天道早安",
    schedule: { kind: "daily", time: "08:00" },
    tz: "Asia/Shanghai",
    action: { tool: "agent_prompt", params: { instruction: "跟用户道早安" } },
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
    mercureTopic: "lobster/user/1749",
    delivery: { channel: "webchat" },
    enabled: true,
    nextRunAt: 0,
    failCount: 0,
    createdAt: 0,
    ...overrides,
  };
}

function makeSubagent(assistantText: string, status: "ok" | "error" | "timeout" = "ok") {
  return {
    run: vi.fn(async () => ({ runId: "r1" })),
    waitForRun: vi.fn(async () => ({ status, error: status === "ok" ? undefined : "boom" })),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: assistantText }],
    })),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
  } as unknown as NonNullable<ActionRunnerDeps["subagent"]>;
}

/** A backend config with a write-capable db, so failed-run billing can persist. */
const configWithDb = {
  db: { host: "h", port: 3306, user: "u", password: "p", database: "superworker" },
} as ActionRunnerDeps["config"];

function deps(over: Partial<ActionRunnerDeps> = {}): ActionRunnerDeps {
  return {
    config: {} as ActionRunnerDeps["config"],
    resolver: {} as ActionRunnerDeps["resolver"],
    registry: {} as ActionRunnerDeps["registry"],
    deliver: vi.fn(async () => true),
    logger,
    ...over,
  };
}

describe("agentPromptAction.validate", () => {
  it("accepts a non-empty instruction and trims it", () => {
    const r = agentPromptAction.validate({ instruction: "  早安  " });
    expect(r).toEqual({ ok: true, params: { instruction: "早安" } });
  });

  it("rejects a missing/blank instruction", () => {
    expect(agentPromptAction.validate({}).ok).toBe(false);
    expect(agentPromptAction.validate({ instruction: "   " }).ok).toBe(false);
  });
});

describe("agentPromptAction runner", () => {
  it("runs in a derived ':sched' session and delivers the assistant reply", async () => {
    const subagent = makeSubagent("早安！今天有 3 件待办。");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));

    const res = await runner(task());

    expect(res.ok).toBe(true);
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1:sched",
        deliver: false,
      }),
    );
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "scheduled",
        body: "早安！今天有 3 件待办。",
        title: "每天道早安",
      }),
      expect.objectContaining({ mercureTopic: "lobster/user/1749", sessionKey: task().sessionKey }),
    );
  });

  it("fails (no delivery) when the subagent runtime is unavailable", async () => {
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent: undefined, deliver }));
    const res = await runner(task());
    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails on subagent timeout without delivering", async () => {
    const subagent = makeSubagent("", "timeout");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));
    const res = await runner(task());
    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails when the assistant reply is empty", async () => {
    const subagent = makeSubagent("   ");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));
    const res = await runner(task());
    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("agentPromptAction billing", () => {
  it("bills the run onto the delivered notification", async () => {
    mockCollectTurnUsage.mockResolvedValue(usage);
    const subagent = makeSubagent("早安！");
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver, usagePolicy }));

    const before = Date.now();
    const res = await runner(task());

    expect(res.ok).toBe(true);
    // Accounting reads the DERIVED session, under the chat agent that owns it.
    expect(mockCollectTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1:sched",
        agentId: "rabbitmq-1749",
        policy: usagePolicy,
      }),
    );
    // The window must open at the run, so a previous fire's tokens (same
    // session) stay out of this one.
    const { sinceMs } = mockCollectTurnUsage.mock.calls[0][0] as { sinceMs: number };
    expect(sinceMs).toBeGreaterThanOrEqual(before);
    expect(sinceMs).toBeLessThanOrEqual(Date.now());
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ usage }), expect.anything());
  });

  it("skips accounting when no currency policy is configured", async () => {
    const subagent = makeSubagent("早安！");
    const deliver = vi.fn<ActionRunnerDeps["deliver"]>(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver }));

    await runner(task());

    expect(mockCollectTurnUsage).not.toHaveBeenCalled();
    expect(deliver.mock.calls[0][0]).not.toHaveProperty("usage");
  });

  it("bills a timed-out run onto an accounting-only row", async () => {
    mockCollectTurnUsage.mockResolvedValue(usage);
    const warn = vi.fn();
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(
      deps({
        config: configWithDb,
        subagent: makeSubagent("", "timeout"),
        deliver,
        usagePolicy,
        logger: { info() {}, warn, error() {}, debug() {} } as unknown as PluginLogger,
      }),
    );

    const res = await runner(task());

    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("spent tokens without delivering");
    const [, row] = mockInsertHistoryRow.mock.calls[0] as [
      unknown,
      { uid: string; response: string; usage: TurnUsageRecord },
    ];
    // Empty response = the row bills but never renders in the user's chat.
    expect(row).toMatchObject({ sessionId: "session_1", uid: "1749", response: "" });
    expect(row.usage.totalCost).toBe(usage.totalCost);
    expect(row.usage.detail).toMatchObject({ outcome: "timeout" });
  });

  it("bills a run that answered with nothing", async () => {
    mockCollectTurnUsage.mockResolvedValue(usage);
    const deliver = vi.fn(async () => true);
    const runner = agentPromptAction.makeRunner(
      deps({ config: configWithDb, subagent: makeSubagent("   "), deliver, usagePolicy }),
    );

    const res = await runner(task());

    expect(res.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    // Collected once for the reply path and reused for the billing write.
    expect(mockCollectTurnUsage).toHaveBeenCalledTimes(1);
    const [, row] = mockInsertHistoryRow.mock.calls[0] as [unknown, { usage: TurnUsageRecord }];
    expect(row.usage.detail).toMatchObject({ outcome: "empty-reply" });
  });

  it("bills a run that threw mid-flight", async () => {
    mockCollectTurnUsage.mockResolvedValue(usage);
    const subagent = makeSubagent("早安！");
    vi.mocked(subagent.run).mockRejectedValueOnce(new Error("gateway reset"));
    const runner = agentPromptAction.makeRunner(
      deps({ config: configWithDb, subagent, usagePolicy }),
    );

    const res = await runner(task());

    expect(res.ok).toBe(false);
    const [, row] = mockInsertHistoryRow.mock.calls[0] as [unknown, { usage: TurnUsageRecord }];
    expect(row.usage.detail).toMatchObject({ outcome: "error" });
  });

  it("does not fail the run when the billing write itself fails", async () => {
    mockCollectTurnUsage.mockResolvedValue(usage);
    mockInsertHistoryRow.mockRejectedValueOnce(new Error("db down"));
    const runner = agentPromptAction.makeRunner(
      deps({ config: configWithDb, subagent: makeSubagent("", "timeout"), usagePolicy }),
    );

    await expect(runner(task())).resolves.toMatchObject({ ok: false });
  });

  it("logs but writes nothing when no db is configured", async () => {
    mockCollectTurnUsage.mockResolvedValue(usage);
    const runner = agentPromptAction.makeRunner(
      deps({ subagent: makeSubagent("", "timeout"), usagePolicy }),
    );

    await runner(task());

    expect(mockInsertHistoryRow).not.toHaveBeenCalled();
  });

  it("still delivers when the transcript yields no usage", async () => {
    mockCollectTurnUsage.mockResolvedValue(undefined);
    const subagent = makeSubagent("早安！");
    const deliver = vi.fn<ActionRunnerDeps["deliver"]>(async () => true);
    const runner = agentPromptAction.makeRunner(deps({ subagent, deliver, usagePolicy }));

    const res = await runner(task());

    expect(res.ok).toBe(true);
    expect(deliver.mock.calls[0][0]).not.toHaveProperty("usage");
  });
});
