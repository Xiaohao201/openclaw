import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger, PluginRuntime } from "../api.js";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  processChatMessage,
  resolveTurnTimeoutMs,
} from "./chat-pipeline.js";
import { buildCitationDirective } from "./citations.js";
import type { DownloadManager } from "./download-manager.js";
import type { HistoryManager } from "./history-manager.js";
import type { ReportTemplateLookup } from "./report-template-lookup.js";
import type { SkillLookup } from "./skill-lookup.js";
import type { TopicResolver } from "./topic-resolver.js";
import type { ChatMessage, MercureConfig } from "./types.js";

type AgentEventListener = (evt: {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}) => void;
type SubagentRunParams = Parameters<PluginRuntime["subagent"]["run"]>[0];

const USER_ID = "42";
const SESSION_ID = "s1";

// The citation directive is prepended to every turn's message; strip it so the
// message-composition assertions can keep their strong exact-match on the rest.
const CITATION_DIRECTIVE = buildCitationDirective();
const withoutCitation = (message: string): string =>
  message.startsWith(CITATION_DIRECTIVE) ? message.slice(CITATION_DIRECTIVE.length) : message;
const SESSION_KEY = `agent:rabbitmq-${USER_ID}:rabbitmq:${USER_ID}:${SESSION_ID}`;

function createChatMessage(): ChatMessage {
  return {
    historyId: 1,
    message: "hi there",
    sessionId: SESSION_ID,
    userId: USER_ID,
    useMemory: true,
    useWebsearch: false,
  };
}

function createHistoryManagerMock() {
  const updateResponse = vi.fn(async () => {});
  const updateMetadata = vi.fn(async () => {});
  const historyManager = {
    getRecord: async () => ({
      id: 1,
      sessionId: SESSION_ID,
      userId: USER_ID,
      message: "hi there",
      response: null,
      toolsUsed: null,
      metadata: null,
      createdAt: new Date(),
    }),
    updateResponse,
    updateMetadata,
  } as unknown as HistoryManager;
  return { historyManager, updateResponse, updateMetadata };
}

function createRuntimeMock(options: {
  workspaceDir: string;
  onRun: (listener: AgentEventListener | undefined) => void;
  /**
   * Emit events here to simulate the real timing: tool/assistant events fire
   * DURING waitForRun, i.e. after run() returned and the pipeline captured its
   * runId. Use this (not onRun) to exercise runId-based scoping.
   */
  onWait?: (listener: AgentEventListener | undefined) => void;
  sessionMessages?: unknown[];
  onRunArgs?: (args: SubagentRunParams) => void;
  onWaitArgs?: (args: { runId: string; timeoutMs: number }) => void;
  /** Override the run outcome to exercise the timeout/error exit paths. */
  waitStatus?: "ok" | "timeout" | "error";
}): PluginRuntime {
  let listener: AgentEventListener | undefined;
  return {
    events: {
      onAgentEvent: (fn: AgentEventListener) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    subagent: {
      run: async (args: SubagentRunParams) => {
        options.onRunArgs?.(args);
        options.onRun(listener);
        return { runId: "r1" };
      },
      waitForRun: async (args: { runId: string; timeoutMs: number }) => {
        options.onWaitArgs?.(args);
        options.onWait?.(listener);
        return { status: options.waitStatus ?? ("ok" as const) };
      },
      getSessionMessages: async () => ({ messages: options.sessionMessages ?? [] }),
    },
    agent: {
      resolveAgentWorkspaceDir: () => options.workspaceDir,
    },
  } as unknown as PluginRuntime;
}

describe("processChatMessage", () => {
  let workspaceDir: string;
  const mercureConfig: MercureConfig = {
    hubUrl: "http://127.0.0.1:9/.well-known/mercure",
    jwtSecret: "test-secret",
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as PluginLogger;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "chat-pipeline-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("forwards only assistant deltas matching this run's sessionKey", async () => {
    // Regression: the listener used to forward EVERY assistant delta in the
    // gateway process; concurrent runs (report subagent, other sessions)
    // leaked into this user's stream as a second "typing" bubble.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "hello" },
        });
        // Concurrent report subagent for another user — must be dropped.
        listener?.({
          runId: "r2",
          seq: 1,
          stream: "assistant",
          ts: 2,
          sessionKey: "agent:rabbitmq-99:report-gen:99:1700000000000",
          data: { delta: "LEAK" },
        });
        // Event without sessionKey — must be dropped.
        listener?.({
          runId: "r3",
          seq: 1,
          stream: "assistant",
          ts: 3,
          data: { delta: "NOKEY" },
        });
        // Non-assistant stream — must be dropped.
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "tool",
          ts: 4,
          sessionKey: SESSION_KEY,
          data: { delta: "TOOL" },
        });
      },
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("hello");
    expect(result).not.toContain("LEAK");
    expect(updateResponse).toHaveBeenCalledWith(1, "hello");
  });

  it("tags every chat Mercure push with the originating historyId", async () => {
    // Regression: text/done events carried no turn identifier, so a stale SSE
    // subscription on the shared per-user topic rendered the next turn's
    // chunks into an old chat bubble ("output before the question").
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "hello" },
        });
      },
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const payloads = fetchMock.mock.calls.map((call) => {
      // The pusher always sends a URL-encoded string body.
      const init = call[1] as { body?: string };
      const params = new URLSearchParams(init.body ?? "");
      return JSON.parse(params.get("data") ?? "{}") as Record<string, unknown>;
    });

    const textEvents = payloads.filter((p) => p.type === "text");
    const doneEvents = payloads.filter((p) => p.type === "done");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(doneEvents).toHaveLength(1);
    for (const evt of [...textEvents, ...doneEvents]) {
      expect(evt.historyId).toBe(1);
    }
  });

  it("pushes sanitized progress events for tool starts, never leaking args", async () => {
    // While the agent runs tools (DB queries) it emits no assistant deltas;
    // the frontend used to see nothing for the whole tool phase. Tool starts
    // must surface as `progress` events carrying only a generic label.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "tool",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: {
            phase: "start",
            name: "exec",
            toolCallId: "t1",
            args: { command: "mysql -uroot -pSECRET -e 'SELECT 1'" },
          },
        });
        // Tool event from a foreign session — must be dropped.
        listener?.({
          runId: "r2",
          seq: 1,
          stream: "tool",
          ts: 2,
          sessionKey: "agent:rabbitmq-99:rabbitmq:99:other",
          data: { phase: "start", name: "exec", toolCallId: "t2" },
        });
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "assistant",
          ts: 3,
          sessionKey: SESSION_KEY,
          data: { delta: "answer" },
        });
      },
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as { body?: string };
      const params = new URLSearchParams(init.body ?? "");
      return JSON.parse(params.get("data") ?? "{}") as Record<string, unknown>;
    });

    // Progress now includes an immediate "理解问题" ack pushed at run start,
    // followed by the sanitized tool-activity line. Assert the tool line is
    // present and correctly tagged rather than pinning the exact count.
    const progressEvents = payloads.filter((p) => p.type === "progress");
    const toolProgress = progressEvents.find((p) => p.content === "正在查询分析数据（第 1 步）…");
    expect(toolProgress).toBeDefined();
    expect(toolProgress?.historyId).toBe(1);
    for (const evt of payloads) {
      expect(JSON.stringify(evt)).not.toContain("SECRET");
      expect(JSON.stringify(evt)).not.toContain("SELECT");
    }
  });

  it("finalizes a still-running tool step before persisting the history timeline", async () => {
    // A tool `start` whose matching `end` never arrives leaves the step
    // "running". The live panel finalizes such stragglers on the stream's
    // `done`, but history replay has no `done` — so the PERSISTED timeline must
    // coerce them to a terminal status, or the reopened "工作过程" panel shows a
    // step spinning forever.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "tool",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { phase: "start", name: "exec", toolCallId: "t1" },
        });
        // No matching `end` for t1 (tool crashed / event lost / synthetic id).
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "assistant",
          ts: 2,
          sessionKey: SESSION_KEY,
          data: { delta: "done" },
        });
      },
    });
    const { historyManager, updateMetadata } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    const [historyId, metadata] = updateMetadata.mock.calls[0] as unknown as [
      number,
      { steps: Array<{ label: string; status: string }> },
    ];
    expect(historyId).toBe(1);
    const steps = metadata.steps;
    // The unfinished tool step is present in the saved timeline…
    expect(steps.some((s) => s.label === "正在查询分析数据")).toBe(true);
    // …and NOTHING is left "running" — every step has a terminal status.
    expect(steps.every((s) => s.status !== "running")).toBe(true);
  });

  it("scopes events by runId when the runtime omits sessionKey (non-webchat run)", async () => {
    // Regression: a non-webchat subagent run never surfaces to the control UI,
    // so emitAgentEvent stamps sessionKey=undefined on every event. Scoping must
    // fall back to runId — otherwise ALL tool/assistant events drop and the
    // "工作过程" timeline shows only the directly-pushed init step while the reply
    // is recovered only from session messages. These events carry NO sessionKey
    // and fire during waitForRun (after run() returned and runId was captured).
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onWait: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "tool",
          ts: 1,
          data: { phase: "start", name: "exec", toolCallId: "t1" },
        });
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "tool",
          ts: 2,
          data: {
            phase: "end",
            name: "exec",
            toolCallId: "t1",
            status: "completed",
            startedAt: 1,
            endedAt: 5,
          },
        });
        // Foreign run, also without sessionKey — must still drop (runId differs).
        listener?.({
          runId: "r2",
          seq: 1,
          stream: "tool",
          ts: 3,
          data: { phase: "start", name: "exec", toolCallId: "t2" },
        });
        listener?.({
          runId: "r1",
          seq: 3,
          stream: "assistant",
          ts: 4,
          data: { delta: "answer" },
        });
      },
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as { body?: string };
      const params = new URLSearchParams(init.body ?? "");
      return JSON.parse(params.get("data") ?? "{}") as Record<string, unknown>;
    });

    // Our run's tool surfaced as start+end `step` events for the timeline...
    const stepEvents = payloads.filter((p) => p.type === "step");
    expect(stepEvents.some((p) => p.stepId === "t1" && p.phase === "start")).toBe(true);
    expect(stepEvents.some((p) => p.stepId === "t1" && p.phase === "end")).toBe(true);
    // ...and the sanitized progress line was pushed too.
    const progressEvents = payloads.filter((p) => p.type === "progress");
    expect(progressEvents.some((p) => p.content === "正在查询分析数据（第 1 步）…")).toBe(true);
    // The foreign run's tool (t2) must not leak into this turn's timeline.
    expect(stepEvents.some((p) => p.stepId === "t2")).toBe(false);
  });

  it("attaches a sanitized, capped reasoning peek to the think step (③)", async () => {
    // When the run streams reasoning, the think step's `end` carries a short
    // summary of it. The summary must be sanitized (no workspace/internal path)
    // and capped — it exposes model reasoning to the external customer.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onWait: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "thinking",
          ts: 1,
          data: { text: "先查 workspace/memory/notes.md 再决定如何回答用户", delta: "…" },
        });
        // The first assistant delta ends the think phase, flushing its summary.
        listener?.({
          runId: "r1",
          seq: 2,
          stream: "assistant",
          ts: 2,
          data: { delta: "答复" },
        });
      },
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(createChatMessage(), historyManager, mercureConfig, runtime, logger);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as { body?: string };
      const params = new URLSearchParams(init.body ?? "");
      return JSON.parse(params.get("data") ?? "{}") as Record<string, unknown>;
    });

    const thinkEnd = payloads.find(
      (p) => p.type === "step" && p.stepId === "think" && p.phase === "end",
    );
    expect(thinkEnd).toBeDefined();
    const detail = thinkEnd?.detail as string | undefined;
    expect(typeof detail).toBe("string");
    // Internal workspace path was stripped from the reasoning peek.
    expect(detail).not.toContain("workspace/");
    expect(detail).not.toContain("memory/");
    expect(detail).toContain("再决定如何回答用户");
  });

  it("prefers the latest assistant session message as the canonical response", async () => {
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: (listener) => {
        listener?.({
          runId: "r1",
          seq: 1,
          stream: "assistant",
          ts: 1,
          sessionKey: SESSION_KEY,
          data: { delta: "partial stream" },
        });
      },
      sessionMessages: [
        { role: "user", content: "hi there" },
        { role: "assistant", content: "full canonical answer" },
      ],
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("full canonical answer");
    expect(updateResponse).toHaveBeenCalledWith(1, "full canonical answer");
  });

  it("extracts text from array-form (block) assistant content without throwing", async () => {
    // Regression: tool-using sessions return content as content blocks, not a
    // string. The pipeline used to assign the raw array to fullResponse, which
    // crashed once the output sanitizer called .replace ("text.replace is not a
    // function"). It must extract the text and persist the string.
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      sessionMessages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "块状内容答案" }] },
      ],
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(result).toBe("块状内容答案");
    expect(updateResponse).toHaveBeenCalledWith(1, "块状内容答案");
  });

  it("injects the resolved topic ownership for an explicit monitoring-data request", async () => {
    // Regression: the chat path used to pass only [userId:...], forcing the
    // agent to guess project ownership from the DB (it once reused a stale
    // hardcoded topic-id list). entity_auth is the source of truth.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async (uid: string) => {
        expect(uid).toBe(USER_ID);
        return {
          topicId: 585,
          useSlaveTopic: true,
          masterId: 270,
          topicName: "广本监测专项",
          topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: "广本监测专项" }],
        };
      },
    } as unknown as TopicResolver;

    const message = "排查昨天的高风险舆情";
    await processChatMessage(
      { ...createChatMessage(), message },
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(withoutCitation(capturedMessage)).toBe(
      `[userId:${USER_ID}] [topicId:585 topicName:"广本监测专项" useSlaveTopic:true] ${message}`,
    );
  });

  it.each([
    "hi there",
    "帮我写一封活动邀请邮件",
    "把这份 Excel 做成图表",
    "分析一下这份合同的风险",
    "把这句话改得别那么负面",
    "总结一下我这周的项目工作",
    "舆情是什么意思？",
    "帮我写一份舆情管理培训大纲",
  ])(
    "does not resolve or inject the default monitoring topic for unrelated work: %s",
    async (message) => {
      let capturedMessage = "";
      const runtime = createRuntimeMock({
        workspaceDir,
        onRun: () => {},
        onRunArgs: (args) => {
          capturedMessage = args.message;
        },
        sessionMessages: [{ role: "assistant", content: "ok" }],
      });
      const { historyManager } = createHistoryManagerMock();
      const getTopicIdsByUser = vi.fn(async () => ({
        topicId: 89,
        useSlaveTopic: false,
        masterId: 89,
        topicName: "华泰联合证券舆情监测",
        topics: [
          {
            topicId: 89,
            useSlaveTopic: false,
            masterId: 89,
            topicName: "华泰联合证券舆情监测",
          },
        ],
      }));
      const topicResolver = { getTopicIdsByUser } as unknown as TopicResolver;

      await processChatMessage(
        { ...createChatMessage(), message },
        historyManager,
        mercureConfig,
        runtime,
        logger,
        undefined,
        topicResolver,
      );

      expect(getTopicIdsByUser).not.toHaveBeenCalled();
      expect(withoutCitation(capturedMessage)).toBe(`[userId:${USER_ID}] ${message}`);
      expect(capturedMessage).not.toContain("华泰联合");
    },
  );

  it.each(["机构违规研判及举报", "通用违规研判和举报函"])(
    "omits enterprise topic context for %s",
    async (capabilityName) => {
      let capturedMessage = "";
      const runtime = createRuntimeMock({
        workspaceDir,
        onRun: () => {},
        onRunArgs: (args) => {
          capturedMessage = args.message;
        },
        sessionMessages: [{ role: "assistant", content: "ok" }],
      });
      const { historyManager } = createHistoryManagerMock();
      const topicResolver = {
        getTopicIdsByUser: async () => ({
          topicId: 89,
          useSlaveTopic: false,
          masterId: 89,
          topicName: "华泰联合证券舆情监测",
          topics: [
            {
              topicId: 89,
              useSlaveTopic: false,
              masterId: 89,
              topicName: "华泰联合证券舆情监测",
            },
          ],
        }),
      } as unknown as TopicResolver;
      const message = `请使用“${capabilityName}”能力，对以下网络内容逐项研判：https://example.com/a`;

      await processChatMessage(
        { ...createChatMessage(), message },
        historyManager,
        mercureConfig,
        runtime,
        logger,
        undefined,
        topicResolver,
      );

      expect(withoutCitation(capturedMessage)).toBe(`[userId:${USER_ID}] ${message}`);
      expect(capturedMessage).not.toContain("华泰联合证券");
    },
  );

  it("lists every owned topic when the user has more than one", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: false,
        masterId: 585,
        topicName: "专题E",
        topics: [
          { topicId: 116, useSlaveTopic: false, masterId: 116, topicName: "专题A" },
          { topicId: 357, useSlaveTopic: false, masterId: 357, topicName: null },
          { topicId: 585, useSlaveTopic: false, masterId: 585, topicName: "专题E" },
        ],
      }),
    } as unknown as TopicResolver;

    const message = "查一下监测项目最近的舆情动态";
    await processChatMessage(
      { ...createChatMessage(), message },
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(withoutCitation(capturedMessage)).toBe(
      `[userId:${USER_ID}] [topicId:585 topicName:"专题E" useSlaveTopic:false]` +
        ` [allTopics: 116:"专题A", 357, 585:"专题E"] ${message}`,
    );
  });

  it("escapes quotes and brackets in topicName via JSON.stringify", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: true,
        masterId: 270,
        topicName: '专项[A] "测试"',
        topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: '专项[A] "测试"' }],
      }),
    } as unknown as TopicResolver;

    const message = "查询舆情数据";
    await processChatMessage(
      { ...createChatMessage(), message },
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(withoutCitation(capturedMessage)).toBe(
      `[userId:${USER_ID}] [topicId:585 topicName:"专项[A] \\"测试\\"" useSlaveTopic:true] ${message}`,
    );
  });

  it("omits topicName from the prefix when the title lookup returned null", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: true,
        masterId: 270,
        topicName: null,
        topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: null }],
      }),
    } as unknown as TopicResolver;

    const message = "这周负面舆情有多少条";
    await processChatMessage(
      { ...createChatMessage(), message },
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(withoutCitation(capturedMessage)).toBe(
      `[userId:${USER_ID}] [topicId:585 useSlaveTopic:true] ${message}`,
    );
  });

  it("falls back to the plain userId prefix when topic resolution fails", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => {
        throw new Error("db down");
      },
    } as unknown as TopicResolver;

    const result = await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(result).toBe("ok");
    expect(withoutCitation(capturedMessage)).toBe(`[userId:${USER_ID}] hi there`);
  });

  it("omits topic context when the user has no topic mapping", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: null,
        useSlaveTopic: false,
        masterId: 0,
        topicName: null,
        topics: [],
      }),
    } as unknown as TopicResolver;

    await processChatMessage(
      createChatMessage(),
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      topicResolver,
    );

    expect(withoutCitation(capturedMessage)).toBe(`[userId:${USER_ID}] hi there`);
  });

  it("greets the user then enqueues the report when a template is selected", async () => {
    // Selecting a report_template ALWAYS produces a report, but the user is first
    // greeted by a streamed conversational reply (the chat subagent runs), and
    // the report is enqueued afterwards with the template's own period + id.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 123);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({
      id: 7,
      period: "周报" as const,
      name: "我的周报",
      content: "# 舆情专报模板\n## 概述\n{summary}",
      description: "客户定制模板",
    }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;

    let ranSubagent = false;
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {
        ranSubagent = true;
      },
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [
        { role: "assistant", content: "好的，我看过这份模板了，这就为您生成周报。" },
      ],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 585,
        useSlaveTopic: false,
        masterId: 585,
        topicName: "专题E",
        topics: [{ topicId: 585, useSlaveTopic: false, masterId: 585, topicName: "专题E" }],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = { ...createChatMessage(), message: "重点关注负面", templateId: 7 };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      undefined,
      undefined,
      templateLookup,
    );

    expect(resolve).toHaveBeenCalledWith(7, USER_ID, logger);
    // The report is still created, with the template's period/id and resolved topic.
    expect(createReportTask).toHaveBeenCalledTimes(1);
    const taskArg = createReportTask.mock.calls[0][0] as unknown as {
      period: string;
      templateId?: number;
      topicId: number;
      requirement: string;
    };
    expect(taskArg.period).toBe("周报");
    expect(taskArg.templateId).toBe(7);
    expect(taskArg.topicId).toBe(585);
    expect(taskArg.requirement).toBe("重点关注负面");
    // The user is greeted first: the chat subagent ran and its reply is returned.
    expect(ranSubagent).toBe(true);
    expect(result).toBe("好的，我看过这份模板了，这就为您生成周报。");
    // The acknowledgement turn is steered and sees the template body.
    expect(capturedMessage).toContain("acknowledge-and-report");
    expect(capturedMessage).toContain("我的周报");
    expect(capturedMessage).toContain("舆情专报模板");
    expect(capturedMessage).toContain("重点关注负面");
  });

  it("routes the report to the requirement-named topic, not just the primary", async () => {
    // Regression: the report path used only resolution.topicId (the most
    // recently granted topic), so a multi-project user asking for "南方基金"
    // got their default project's report. The requirement name must win within
    // the authorized topic set.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({ id: 4, period: "日报" as const, name: "火灾速报" }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;
    const runtime = createRuntimeMock({ workspaceDir, onRun: () => {} });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 89, // primary = most recently granted
        useSlaveTopic: false,
        masterId: 89,
        topicName: "广汽本田",
        topics: [
          { topicId: 89, useSlaveTopic: false, masterId: 89, topicName: "广汽本田" },
          { topicId: 204, useSlaveTopic: false, masterId: 204, topicName: "南方基金" },
        ],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "用这个模板做一个南方基金6月3号到6月8号的报告",
      templateId: 4,
    };
    await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      undefined,
      undefined,
      templateLookup,
    );

    const taskArg = createReportTask.mock.calls[0][0] as unknown as { topicId: number };
    expect(taskArg.topicId).toBe(204);
  });

  it("routes the report to the LLM-chosen topic over the substring match", async () => {
    // The requirement text substring-matches 南方基金 (#204), but the LLM
    // classifier resolves intent to 招商证券 (#305). The LLM pick is
    // authoritative when it returns a valid authorized topic; only on an
    // unavailable/unsure model do we fall back to substring matching.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({ id: 4, period: "日报" as const, name: "火灾速报" }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      sessionMessages: [{ role: "assistant", content: '好的 {"topicId": 305}' }],
    });
    const { historyManager } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 89,
        useSlaveTopic: false,
        masterId: 89,
        topicName: "广汽本田",
        topics: [
          { topicId: 89, useSlaveTopic: false, masterId: 89, topicName: "广汽本田" },
          { topicId: 204, useSlaveTopic: false, masterId: 204, topicName: "南方基金" },
          { topicId: 305, useSlaveTopic: false, masterId: 305, topicName: "招商证券" },
        ],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "用这个模板做一个南方基金6月的报告",
      templateId: 4,
    };
    await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      undefined,
      undefined,
      templateLookup,
    );

    const taskArg = createReportTask.mock.calls[0][0] as unknown as { topicId: number };
    expect(taskArg.topicId).toBe(305);
  });

  it("does not alter the subagent message when use_memory is true (default)", async () => {
    // Regression guard: the memory directive must be empty on the default path so
    // recall (and the existing message format) stays intact.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      { ...createChatMessage(), useMemory: true },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(withoutCitation(capturedMessage)).toBe(`[userId:${USER_ID}] hi there`);
    expect(capturedMessage).not.toContain("no-memory");
  });

  it("injects the Suheng design context for visual artifact requests", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      { ...createChatMessage(), message: "请设计一个可交互的舆情看板" },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(capturedMessage).toContain("[suheng-design]");
    expect(capturedMessage).toContain("Delivery compatibility for ai-assistant");
    expect(capturedMessage).toContain(`[userId:${USER_ID}] 请设计一个可交互的舆情看板`);
  });

  it("preserves Chinese workspace names without embedding them in Python source", async () => {
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      { ...createChatMessage(), message: "请创建工作文件夹：舆情报告（夙衡）" },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(capturedMessage).toContain("[suheng-workspace]");
    expect(capturedMessage).toContain("保留用户要求的中文目录名和文件名");
    expect(capturedMessage).toContain("pathlib.Path(sys.argv[1])");
    expect(capturedMessage).toContain("python -m py_compile");
    expect(capturedMessage).toContain(`[userId:${USER_ID}] 请创建工作文件夹：舆情报告（夙衡）`);
  });

  it("prefixes a no-memory directive when use_memory is false", async () => {
    // use_memory:false must reach the agent: memory tools are agent-level and
    // cannot be removed per-run, so we suppress recall via a prompt directive.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      { ...createChatMessage(), useMemory: false },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(capturedMessage).toContain("[no-memory]");
    expect(capturedMessage).toContain("memory_search");
    // The directive prefixes — it never replaces — the user payload.
    expect(capturedMessage).toContain(`[userId:${USER_ID}] hi there`);
  });

  it("acknowledges a keyword report instantly without blocking on the feed count", async () => {
    // Regression: the ack used to run a COUNT before replying, and returned an
    // early "暂无数据" when it was 0. A slow COUNT on a high-volume topic blew
    // the frontend's response deadline. The task must now be created and acked
    // regardless of the count; the empty case is handled by the report-generator.
    const createReportTask = vi.fn(async (_args: Record<string, unknown>) => 321);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    // A count that resolves to 0 (and even slowly) must NOT short-circuit the ack.
    const countFeedData = vi.fn(async () => 0);
    const feedCounter = { countFeedData } as unknown as never;

    let ranSubagent = false;
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {
        ranSubagent = true;
      },
    });
    const { historyManager, updateResponse } = createHistoryManagerMock();
    const topicResolver = {
      getTopicIdsByUser: async () => ({
        topicId: 89,
        useSlaveTopic: false,
        masterId: 89,
        topicName: "广汽本田",
        topics: [{ topicId: 89, useSlaveTopic: false, masterId: 89, topicName: "广汽本田" }],
      }),
    } as unknown as TopicResolver;

    const chatMsg: ChatMessage = { ...createChatMessage(), message: "给我生成一份广汽本田的月报" };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      topicResolver,
      feedCounter,
    );

    expect(createReportTask).toHaveBeenCalledTimes(1);
    expect(result).toBe("月报报告已创建，正在生成中...");
    expect(result).not.toContain("暂无");
    expect(updateResponse).toHaveBeenCalledWith(1, "月报报告已创建，正在生成中...");
    // The keyword report path never runs the chat subagent.
    expect(ranSubagent).toBe(false);
  });

  it("falls through to normal chat when the templateId does not resolve", async () => {
    // A deleted / disabled / foreign templateId must not silently drop the
    // turn: it degrades to ordinary chat handling.
    const createReportTask = vi.fn(async () => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const templateLookup = {
      resolve: vi.fn(async () => null),
    } as unknown as ReportTemplateLookup;

    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      sessionMessages: [{ role: "assistant", content: "normal answer" }],
    });
    const { historyManager } = createHistoryManagerMock();

    const chatMsg: ChatMessage = { ...createChatMessage(), message: "hi there", templateId: 999 };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      undefined,
      undefined,
      undefined,
      templateLookup,
    );

    expect(createReportTask).not.toHaveBeenCalled();
    expect(result).toBe("normal answer");
  });

  it("greets first, then still generates the report, for a conversational template message", async () => {
    // The original complaint: "你先学习一下这份模版，接下来合作" arrived WITH a templateId
    // and spawned a report with no conversation. New behavior: the agent greets
    // (chat subagent runs, template body injected so it can learn it) AND the
    // report is still generated — selecting a template is the request for it.
    const createReportTask = vi.fn(async () => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({
      id: 7,
      period: "周报" as const,
      name: "我的周报",
      content: "# 舆情专报模板\n## 概述\n{summary}",
      description: "客户定制模板",
    }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;

    let capturedMessage = "";
    let ranSubagent = false;
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {
        ranSubagent = true;
      },
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [
        { role: "assistant", content: "好的，我已经看过这份模板了，这就为您生成。" },
      ],
    });
    const { historyManager } = createHistoryManagerMock();

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "你先学习一下这份舆情专报的模版，接下来我跟你一起合作",
      templateId: 7,
    };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      undefined,
      undefined,
      undefined,
      templateLookup,
    );

    // Greeted first: the chat subagent ran and its reply is returned.
    expect(ranSubagent).toBe(true);
    expect(result).toBe("好的，我已经看过这份模板了，这就为您生成。");
    // The report is still generated after the greeting.
    expect(createReportTask).toHaveBeenCalledTimes(1);
    // The template body is injected so the agent can actually "learn" it.
    expect(capturedMessage).toContain("用户当前选中了报告模板");
    expect(capturedMessage).toContain("舆情专报模板");
    // The user's words are still present, ahead of the injected template block.
    expect(capturedMessage).toContain("你先学习一下这份舆情专报的模版");
  });

  it("does NOT route a keyword report to the internal DB when a file is attached", async () => {
    // Regression: uploading an Excel + a prompt containing "日报/月报" wrongly
    // triggered the keyword path, which queried the 智脑 feed tables (ignoring
    // the upload) and returned "暂无舆情数据". With an attachment the turn must
    // run as a normal chat so the agent analyzes the spliced file content.
    const createReportTask = vi.fn(async () => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const countFeedData = vi.fn(async () => 0);
    const feedCounter = { countFeedData } as unknown as never;

    let ranSubagent = false;
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {
        ranSubagent = true;
      },
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "已根据附件生成日报分析" }],
    });
    const { historyManager } = createHistoryManagerMock();

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "请基于附件生成深圳卫健委3月舆情日报分析",
      hasAttachment: true,
    };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      undefined,
      feedCounter,
    );

    // No internal-DB report task, and the chat subagent ran on the upload.
    expect(createReportTask).not.toHaveBeenCalled();
    expect(ranSubagent).toBe(true);
    expect(result).toBe("已根据附件生成日报分析");
    // The agent is steered to use the attachment, not the internal 舆情库.
    expect(capturedMessage).toContain("analyze-attachment");
    expect(capturedMessage).toContain("仅依据附件中的数据");
  });

  it("keeps a selected template as a format guide (no internal-DB report) when a file is attached", async () => {
    // Selecting a report template normally forces an internal-DB report. With an
    // attachment, the template must instead serve only as a structure/format
    // guide while the agent writes the report from the uploaded data.
    const createReportTask = vi.fn(async () => 1);
    const downloadManager = { createReportTask } as unknown as DownloadManager;
    const resolve = vi.fn(async () => ({
      id: 7,
      period: "日报" as const,
      name: "卫健委舆情专报",
      content: "# 舆情专报模板\n## 重点事件\n{events}",
      description: "政务模板",
    }));
    const templateLookup = { resolve } as unknown as ReportTemplateLookup;

    let ranSubagent = false;
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {
        ranSubagent = true;
      },
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "已按模板用附件数据产出报告" }],
    });
    const { historyManager } = createHistoryManagerMock();

    const chatMsg: ChatMessage = {
      ...createChatMessage(),
      message: "请基于附件按这份专报模板生成分析",
      templateId: 7,
      hasAttachment: true,
    };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      downloadManager,
      undefined,
      undefined,
      undefined,
      templateLookup,
    );

    // The template resolved (so it can guide format) but NO report was enqueued.
    expect(resolve).toHaveBeenCalledWith(7, USER_ID, logger);
    expect(createReportTask).not.toHaveBeenCalled();
    expect(ranSubagent).toBe(true);
    expect(result).toBe("已按模板用附件数据产出报告");
    // Template body is injected as a guide, and the attachment directive names it.
    expect(capturedMessage).toContain("analyze-attachment");
    expect(capturedMessage).toContain("卫健委舆情专报");
    expect(capturedMessage).toContain("舆情专报模板");
    // It must NOT use the report-acknowledgement directive (that path is skipped).
    expect(capturedMessage).not.toContain("acknowledge-and-report");
  });

  it("injects active custom skills into the subagent context, not the visible message", async () => {
    // A skill activated in "我的Skills" is resolved by id (ownership-checked) and
    // its instructions are APPENDED to the agent context — after the user's text —
    // so the chat bubble never shows the raw instructions.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const resolveMany = vi.fn(async () => [
      { id: 3, name: "竞品负面过滤器", content: "只保留竞品相关的负面舆情", description: "过滤器" },
      { id: 5, name: "口径校准", content: "统一称谓为“本行”", description: null },
    ]);
    const skillLookup = { resolveMany } as unknown as SkillLookup;

    const chatMsg: ChatMessage = { ...createChatMessage(), skillIds: [3, 5] };
    const result = await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skillLookup,
    );

    expect(resolveMany).toHaveBeenCalledWith([3, 5], USER_ID, logger);
    expect(result).toBe("ok");
    // Both skills' names + bodies are present in the injected block.
    expect(capturedMessage).toContain("启用了以下自定义技能");
    expect(capturedMessage).toContain("竞品负面过滤器");
    expect(capturedMessage).toContain("只保留竞品相关的负面舆情");
    expect(capturedMessage).toContain("口径校准");
    // The user's original text stays ahead of the injected skill block.
    const userIdx = capturedMessage.indexOf("hi there");
    const skillIdx = capturedMessage.indexOf("启用了以下自定义技能");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThan(userIdx);
  });

  it("runs with only the selected bundled skill and ignores custom skill ids", async () => {
    let capturedSkillFilter: string[] | undefined;
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedSkillFilter = args.skillFilter;
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const resolveMany = vi.fn(async () => [
      { id: 3, name: "不应加载", content: "不应注入", description: null },
    ]);
    const skillLookup = { resolveMany } as unknown as SkillLookup;

    await processChatMessage(
      {
        ...createChatMessage(),
        skillIds: [3],
        builtinSkillName: "ai-collaboration-diagnostic",
      },
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skillLookup,
    );

    expect(capturedSkillFilter).toEqual(["ai-collaboration-diagnostic"]);
    expect(resolveMany).not.toHaveBeenCalled();
    expect(capturedMessage).not.toContain("启用了以下自定义技能");
    expect(capturedMessage).not.toContain("不应注入");
  });

  it("auto-selects the brief skill for an unmistakable public-opinion brief request", async () => {
    let capturedSkillFilter: string[] | undefined;
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedSkillFilter = args.skillFilter;
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();

    await processChatMessage(
      {
        ...createChatMessage(),
        message: "深圳赛百味维修人员穿鞋踩踏出餐区，写撰写该事件舆情速报",
      },
      historyManager,
      mercureConfig,
      runtime,
      logger,
    );

    expect(capturedSkillFilter).toEqual(["ai-public-opinion-brief"]);
    expect(capturedMessage).toContain("请使用 $ai-public-opinion-brief 完成任务");
  });

  it("does not inject a skill block when no skill id resolves", async () => {
    // Unresolvable ids (deleted / disabled / another user's) resolve to [] and the
    // turn degrades to an ordinary chat with no injected block.
    let capturedMessage = "";
    const runtime = createRuntimeMock({
      workspaceDir,
      onRun: () => {},
      onRunArgs: (args) => {
        capturedMessage = args.message;
      },
      sessionMessages: [{ role: "assistant", content: "ok" }],
    });
    const { historyManager } = createHistoryManagerMock();
    const skillLookup = { resolveMany: vi.fn(async () => []) } as unknown as SkillLookup;

    const chatMsg: ChatMessage = { ...createChatMessage(), skillIds: [999] };
    await processChatMessage(
      chatMsg,
      historyManager,
      mercureConfig,
      runtime,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skillLookup,
    );

    expect(withoutCitation(capturedMessage)).toBe(`[userId:${USER_ID}] hi there`);
    expect(capturedMessage).not.toContain("启用了以下自定义技能");
  });

  describe("turn timeout", () => {
    function runWithTimeout(turnTimeoutMs?: number) {
      const seen: Array<{ runId: string; timeoutMs: number }> = [];
      const runtime = createRuntimeMock({
        workspaceDir,
        onRun: () => {},
        onWaitArgs: (args) => seen.push(args),
      });
      const { historyManager } = createHistoryManagerMock();
      return processChatMessage(
        createChatMessage(),
        historyManager,
        mercureConfig,
        runtime,
        logger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        turnTimeoutMs === undefined ? undefined : { turnTimeoutMs },
      ).then(() => seen);
    }

    it("keeps the historical 5-minute ceiling when unconfigured", async () => {
      const seen = await runWithTimeout();
      expect(seen[0]?.timeoutMs).toBe(300_000);
    });

    it("applies a configured ceiling", async () => {
      const seen = await runWithTimeout(900_000);
      expect(seen[0]?.timeoutMs).toBe(900_000);
    });

    it("clamps a too-small ceiling up to the minimum", async () => {
      const seen = await runWithTimeout(5_000);
      expect(seen[0]?.timeoutMs).toBe(60_000);
    });

    it("clamps a too-large ceiling down to the maximum", async () => {
      const seen = await runWithTimeout(7_200_000);
      expect(seen[0]?.timeoutMs).toBe(3_600_000);
    });

    it("falls back to the default for a non-positive or non-finite value", async () => {
      expect((await runWithTimeout(0))[0]?.timeoutMs).toBe(300_000);
      expect((await runWithTimeout(Number.NaN))[0]?.timeoutMs).toBe(300_000);
    });

    it("persists and returns the Suheng learning fallback when the turn times out", async () => {
      const runtime = createRuntimeMock({
        workspaceDir,
        onRun: () => {},
        waitStatus: "timeout",
      });
      const { historyManager, updateResponse, updateMetadata } = createHistoryManagerMock();

      const result = await processChatMessage(
        createChatMessage(),
        historyManager,
        mercureConfig,
        runtime,
        logger,
      );

      const timeoutReply = "这个任务暂时无法完成，但是夙衡已经自动学习，争取尽早完善。";
      expect(result).toBe(timeoutReply);
      expect(updateResponse).toHaveBeenCalledWith(1, timeoutReply);
      const metadataPatches = updateMetadata.mock.calls as unknown as Array<
        [number, { steps?: Array<{ status: string }> }]
      >;
      const steps = metadataPatches.findLast(([, patch]) => Array.isArray(patch?.steps))?.[1]
        ?.steps;
      expect(steps?.some((step) => step.status === "failed")).toBe(true);
    });
  });
});

describe("resolveTurnTimeoutMs", () => {
  it("passes through a value inside the supported window", () => {
    expect(resolveTurnTimeoutMs(600_000)).toBe(600_000);
  });

  it("defaults when unset", () => {
    expect(resolveTurnTimeoutMs(undefined)).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });

  it("clamps both ends", () => {
    expect(resolveTurnTimeoutMs(1_000)).toBe(60_000);
    expect(resolveTurnTimeoutMs(99_999_999)).toBe(3_600_000);
  });
});
