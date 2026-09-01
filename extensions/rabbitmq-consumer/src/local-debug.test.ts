import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger, PluginRuntime } from "../api.js";
import {
  buildLocalDebugTrace,
  createLocalDebugHttpHandler,
  createLocalDebugExecutor,
  createLocalDebugRunner,
  type LocalDebugRunPipeline,
} from "./local-debug.js";
import type { SkillLookup, SkillSummary } from "./skill-lookup.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as PluginLogger;

const runtime = {} as PluginRuntime;
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  vi.clearAllMocks();
});

describe("rabbitmq local debug runner", () => {
  it("builds expandable sanitized details and merges start/end events", () => {
    const trace = buildLocalDebugTrace([
      {
        type: "step",
        phase: "start",
        stepId: "feed-1",
        index: 2,
        label: "正在浏览舆情列表",
        category: "query",
        status: "running",
      },
      { type: "progress", content: "正在浏览舆情列表（第 1 步）…" },
      {
        type: "step",
        phase: "end",
        stepId: "feed-1",
        index: 2,
        label: "正在浏览舆情列表",
        category: "query",
        status: "completed",
        durationMs: 42,
        detail: "获取 1 条",
      },
      { type: "text", content: "最终回答" },
      { type: "done" },
    ]);

    expect(trace).toEqual([
      {
        id: "feed-1",
        summary: "正在浏览舆情列表",
        category: "query",
        status: "completed",
        durationMs: 42,
        narrative: ["获取 1 条。"],
      },
    ]);
  });

  it("removes framework-only phases and progress noise from completed turns", () => {
    const trace = buildLocalDebugTrace(
      [
        {
          type: "step",
          phase: "end",
          stepId: "init",
          label: "正在理解您的问题",
          category: "default",
          status: "completed",
          durationMs: 18_585,
        },
        { type: "progress", content: "正在理解您的问题…" },
        {
          type: "step",
          phase: "end",
          stepId: "answer",
          label: "正在组织回答",
          category: "answer",
          status: "completed",
          durationMs: 11_552,
        },
        { type: "done" },
      ],
      { request: "你能做什么？", response: "我可以帮你查询和分析舆情。" },
    );

    expect(trace).toEqual([]);
    expect(JSON.stringify(trace)).not.toContain("正在理解您的问题");
    expect(JSON.stringify(trace)).not.toContain("正在组织回答");
    expect(JSON.stringify(trace)).not.toContain("进度更新");
  });

  it("omits synthetic thinking steps and their internal references", () => {
    const trace = buildLocalDebugTrace([
      {
        type: "step",
        phase: "end",
        stepId: "think",
        index: 1,
        label: "正在思考分析",
        category: "think",
        status: "completed",
        detail: "已读取 `skills/secret/SKILL.md`，会话 agent:rabbitmq-1749:main 已完成分析",
      },
    ]);

    expect(trace).toEqual([]);
    expect(JSON.stringify(trace)).not.toContain("secret");
    expect(JSON.stringify(trace)).not.toContain("rabbitmq-1749");
  });

  it("prefers concrete public tool observations over generic template text", () => {
    const trace = buildLocalDebugTrace([
      {
        type: "step",
        phase: "end",
        stepId: "feed-1",
        label: "正在浏览舆情列表",
        category: "query",
        status: "completed",
        publicNarrative: [
          "我会读取 topicId=553 的第 1 页，每页 1 条舆情。",
          "接口报告共有 18 条匹配，本次返回 1 条。",
          "其中一条是《深圳某项目施工进展》（微信，风险等级高）。",
          "内部路径 `skills/secret/SKILL.md` 不应展示。",
        ],
      },
    ]);

    expect(trace[0]?.narrative).toEqual([
      "我会读取 topicId=553 的第 1 页，每页 1 条舆情。",
      "接口报告共有 18 条匹配，本次返回 1 条。",
      "其中一条是《深圳某项目施工进展》（微信，风险等级高）。",
      "内部 不应展示。",
    ]);
    expect(JSON.stringify(trace)).not.toContain("secret");
  });

  it("keeps only actual tool work instead of adding a synthetic reasoning record", () => {
    const trace = buildLocalDebugTrace(
      [
        {
          type: "step",
          phase: "end",
          stepId: "feed-1",
          index: 1,
          label: "正在浏览舆情列表",
          category: "query",
          status: "completed",
          durationMs: 42,
          detail: "获取 1 条",
        },
        {
          type: "step",
          phase: "end",
          stepId: "answer-1",
          index: 2,
          label: "正在组织回答",
          category: "answer",
          status: "completed",
          durationMs: 8,
        },
      ],
      {
        request: "查询 topicId=553 的舆情数据",
        response:
          "查询成功，共返回 1 条。内部引用 `skills/secret/SKILL.md`，会话 agent:rabbitmq-1749:main。",
      },
    );

    expect(trace).toEqual([
      {
        id: "feed-1",
        summary: "正在浏览舆情列表",
        category: "query",
        status: "completed",
        durationMs: 42,
        narrative: ["获取 1 条。"],
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain("secret");
    expect(JSON.stringify(trace)).not.toContain("rabbitmq-1749");
  });

  it("builds safe citation, report, failure, and fallback trace items", () => {
    const trace = buildLocalDebugTrace([
      {
        type: "step",
        phase: "end",
        stepId: "",
        index: "invalid",
        label: "",
        category: "unknown",
        status: "failed",
        durationMs: -1,
      },
      { type: "progress", content: "" },
      {
        type: "citations",
        citations: [{ title: "公开来源" }, null, ["invalid"]],
      },
      { type: "report_created", taskId: 202 },
      { type: "error", error: "C:/secret/internal.log" },
    ]);

    expect(trace).toEqual([
      {
        id: "step-1",
        summary: "执行处理步骤",
        category: "default",
        status: "failed",
        narrative: ["这一步没有返回可用结果，详细错误已留在服务端日志中。"],
      },
      {
        id: "citations-1",
        summary: "整理引用来源",
        category: "read",
        status: "completed",
        narrative: ["我整理了 3 个引用来源。", "其中包括：公开来源。"],
      },
      {
        id: "report-1",
        summary: "报告任务已创建",
        category: "report",
        status: "completed",
        narrative: ["报告任务已创建，任务编号为 202。"],
      },
      {
        id: "error-1",
        summary: "处理过程出现异常",
        category: "check",
        status: "failed",
        narrative: ["执行未完成；详细内部错误仅保留在服务端日志中。"],
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain("secret");
  });

  it("finalizes an unmatched running step when the local turn is complete", () => {
    const trace = buildLocalDebugTrace([
      {
        type: "step",
        phase: "start",
        stepId: "tool-1",
        index: 1,
        label: "正在浏览舆情列表",
        category: "query",
        status: "running",
      },
      { type: "done" },
    ]);

    expect(trace[0]).toMatchObject({ status: "completed" });
    expect(trace[0]?.narrative).toEqual([]);
  });

  it("collapses adjacent repeated steps when neither contains factual detail", () => {
    const trace = buildLocalDebugTrace([
      {
        type: "step",
        phase: "end",
        stepId: "share-1",
        label: "正在生成可下载文件",
        category: "write",
        status: "completed",
        durationMs: 100,
      },
      {
        type: "step",
        phase: "end",
        stepId: "share-2",
        label: "正在生成可下载文件",
        category: "write",
        status: "completed",
        durationMs: 211,
      },
    ]);

    expect(trace).toEqual([
      {
        id: "share-1",
        summary: "正在生成可下载文件",
        category: "write",
        status: "completed",
        durationMs: 311,
        repeatCount: 2,
        narrative: [],
      },
    ]);
  });

  it("executes queued messages outside the plugin HTTP request scope", async () => {
    const requestScope = new AsyncLocalStorage<string>();
    const observedScopes: Array<string | undefined> = [];
    const execute = createLocalDebugExecutor(async (payload) => {
      observedScopes.push(requestScope.getStore());
      return payload;
    });

    const result = await requestScope.run("plugin-http", async () => await execute("message"));

    expect(result).toBe("message");
    expect(observedScopes).toEqual([undefined]);
  });

  it("keeps processing queued messages after one execution fails", async () => {
    const execute = createLocalDebugExecutor(async (payload) => {
      if (payload === "fail") {
        throw new Error("simulated failure");
      }
      return payload;
    });

    await expect(execute("fail")).rejects.toThrow("simulated failure");
    await expect(execute("next")).resolves.toBe("next");
  });

  it("parses the real RabbitMQ envelope and records sanitized pipeline events", async () => {
    const runPipeline = vi.fn<LocalDebugRunPipeline>(async ({ chatMsg, eventPusher }) => {
      expect(chatMsg).toMatchObject({
        historyId: 101,
        message: "分析这条测试消息",
        sessionId: "local-session",
        userId: "local-user",
      });

      await eventPusher.pushStep(
        "local-user",
        {
          phase: "start",
          stepId: "think",
          index: 1,
          label: "正在思考分析",
          category: "think",
          status: "running",
        },
        101,
      );
      await eventPusher.pushProgress("local-user", "正在分析测试数据…", 101);
      await eventPusher.pushStep(
        "local-user",
        {
          phase: "end",
          stepId: "think",
          index: 1,
          label: "正在思考分析",
          category: "think",
          status: "completed",
          durationMs: 12,
          detail: "已完成脱敏推理摘要",
        },
        101,
      );
      await eventPusher.pushText("local-user", "测试回答", 101);
      await eventPusher.pushCitations(
        "local-user",
        [
          {
            id: 1,
            url: "https://example.com/source",
            title: "本地测试来源",
            snippet: "本地测试摘要",
          },
        ],
        101,
      );
      await eventPusher.pushReportCreated("local-user", 202);
      await eventPusher.pushError("local-user", "已脱敏的测试错误", 101);
      await eventPusher.pushDone("local-user", 101);
      return "测试回答";
    });

    const run = createLocalDebugRunner({ runtime, config: {}, logger, runPipeline });
    const result = await run({
      id: 101,
      message: "分析这条测试消息",
      session_id: "local-session",
      user_id: "local-user",
      use_memory: false,
    });

    expect(runPipeline).toHaveBeenCalledOnce();
    expect(result.response).toBe("测试回答");
    expect(result.events.map((event) => event.type)).toEqual([
      "step",
      "progress",
      "step",
      "text",
      "citations",
      "report_created",
      "error",
      "done",
    ]);
    expect(result.events[2]).toMatchObject({
      detail: "已完成脱敏推理摘要",
      historyId: 101,
    });
    expect(result.trace.map(({ id, category, status }) => ({ id, category, status }))).toEqual([
      { id: "citations-1", category: "read", status: "completed" },
      { id: "report-1", category: "report", status: "completed" },
      { id: "error-1", category: "check", status: "failed" },
    ]);
    expect(result.trace.some((item) => item.id === "think")).toBe(false);
    expect(result.trace.some((item) => item.id.startsWith("progress-"))).toBe(false);
  });

  it("rejects malformed RabbitMQ envelopes without running the model", async () => {
    const runPipeline = vi.fn<LocalDebugRunPipeline>();
    const run = createLocalDebugRunner({ runtime, config: {}, logger, runPipeline });

    await expect(run({ message: "missing id" })).rejects.toThrow("Invalid RabbitMQ debug message");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("rejects payloads that cannot be serialized as RabbitMQ JSON", async () => {
    const runPipeline = vi.fn<LocalDebugRunPipeline>();
    const run = createLocalDebugRunner({ runtime, config: {}, logger, runPipeline });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(run(circular)).rejects.toThrow("payload is not JSON serializable");
    await expect(run(undefined)).rejects.toThrow("payload is not JSON serializable");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("preserves one RabbitMQ session across consecutive chat turns", async () => {
    const observed: Array<{ historyId: number; sessionId: string; message: string }> = [];
    const runPipeline = vi.fn<LocalDebugRunPipeline>(async ({ chatMsg }) => {
      observed.push({
        historyId: chatMsg.historyId,
        sessionId: chatMsg.sessionId,
        message: chatMsg.message,
      });
      return `回答 ${chatMsg.historyId}`;
    });
    const run = createLocalDebugRunner({ runtime, config: {}, logger, runPipeline });

    await run({ id: 201, message: "第一条", session_id: "chat-a", user_id: "local-user" });
    await run({ id: 202, message: "第二条", session_id: "chat-a", user_id: "local-user" });

    expect(observed).toEqual([
      { historyId: 201, sessionId: "chat-a", message: "第一条" },
      { historyId: 202, sessionId: "chat-a", message: "第二条" },
    ]);
  });

  it("persists the simulated RabbitMQ envelope before running the real pipeline", async () => {
    const historyManager = {
      createRecord: vi.fn(async () => {}),
      getRecord: vi.fn(async () => null),
      updateResponse: vi.fn(async () => {}),
      updateMetadata: vi.fn(async () => {}),
    };
    const runPipeline = vi.fn<LocalDebugRunPipeline>(async ({ historyManager: received }) => {
      expect(received).toBe(historyManager);
      expect(historyManager.createRecord).toHaveBeenCalledOnce();
      return "已写入测试历史";
    });
    const run = createLocalDebugRunner({
      runtime,
      config: {},
      logger,
      runPipeline,
      historyManager,
    });

    await run({
      id: 203,
      message: "落表测试",
      session_id: "chat-db",
      user_id: "local-user",
    });

    expect(historyManager.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ historyId: 203, sessionId: "chat-db", message: "落表测试" }),
    );
  });

  it("passes a selected bundled skill through the RabbitMQ envelope", async () => {
    const runPipeline = vi.fn<LocalDebugRunPipeline>(async ({ chatMsg }) => {
      expect(chatMsg.builtinSkillName).toBe("ai-public-opinion-brief");
      return "技能回答";
    });
    const run = createLocalDebugRunner({ runtime, config: {}, logger, runPipeline });

    await run({
      id: 301,
      message: "生成简报",
      session_id: "skill-chat",
      user_id: "local-user",
      builtin_skill_name: "ai-public-opinion-brief",
    });

    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it("passes selected MySQL skills and their lookup into the local pipeline", async () => {
    const skillLookup = {} as SkillLookup;
    const runPipeline = vi.fn<LocalDebugRunPipeline>(async ({ chatMsg, skillLookup: received }) => {
      expect(chatMsg).toMatchObject({ userId: "42", skillIds: [7, 9] });
      expect(received).toBe(skillLookup);
      return "自定义技能回答";
    });
    const run = createLocalDebugRunner({
      runtime,
      config: {},
      logger,
      runPipeline,
      skillLookup,
    });

    await run({
      id: 302,
      message: "使用我的技能",
      session_id: "mysql-skill-chat",
      user_id: "42",
      skill_ids: [7, 9],
    });

    expect(runPipeline).toHaveBeenCalledOnce();
  });
});

describe("rabbitmq local debug HTTP surface", () => {
  const debugRoot = "/plugins/rabbitmq-consumer/debug";

  async function startHandler(
    run: (payload: unknown) => Promise<unknown>,
    listSkills?: (userId: string) => Promise<SkillSummary[]>,
  ) {
    const handler = createLocalDebugHttpHandler({ run, logger, listSkills });
    const server = createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("debug test server did not bind");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async function openDebugSession(baseUrl: string): Promise<string> {
    const response = await fetch(`${baseUrl}${debugRoot}`, { redirect: "manual" });
    const setCookie = response.headers.get("set-cookie");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?mode=rabbitmq-debug");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain(`Path=${debugRoot}`);
    const cookie = setCookie?.split(";", 1)[0];
    if (!cookie) {
      throw new Error("debug session cookie was not issued");
    }
    return cookie;
  }

  it("redirects the loopback debug entry to the Control UI debug mode", async () => {
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }));
    const response = await fetch(`${baseUrl}/plugins/rabbitmq-consumer/debug`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?mode=rabbitmq-debug");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  it("rejects API requests without the path-scoped debug session", async () => {
    const run = vi.fn(async () => ({ response: "unused", events: [] }));
    const listSkills = vi.fn(async () => []);
    const baseUrl = await startHandler(run, listSkills);

    const skillsResponse = await fetch(`${baseUrl}${debugRoot}/skills?user_id=42`);
    const runResponse = await fetch(`${baseUrl}${debugRoot}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, message: "test", user_id: "42", session_id: "one" }),
    });

    expect(skillsResponse.status).toBe(401);
    await expect(skillsResponse.json()).resolves.toEqual({
      error: "RabbitMQ local debug session is missing or expired",
    });
    expect(runResponse.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("rejects an invalid debug session cookie", async () => {
    const run = vi.fn(async () => ({ response: "unused", events: [] }));
    const baseUrl = await startHandler(run);

    const response = await fetch(`${baseUrl}${debugRoot}/run`, {
      method: "POST",
      headers: {
        cookie: "openclaw.rabbitmq_debug=invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: 1, message: "test", user_id: "42", session_id: "one" }),
    });

    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs one simulated inbound message and returns its observable timeline", async () => {
    const run = vi.fn(async () => ({
      response: "本地回答",
      events: [{ type: "done", historyId: 7 }],
    }));
    const baseUrl = await startHandler(run);
    const cookie = await openDebugSession(baseUrl);
    const payload = { id: 7, message: "本地测试", user_id: "dev", session_id: "one" };

    const response = await fetch(`${baseUrl}/plugins/rabbitmq-consumer/debug/run`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      response: "本地回答",
      events: [{ type: "done", historyId: 7 }],
    });
    expect(run).toHaveBeenCalledWith(payload);
  });

  it("lists MySQL skill metadata for one user without exposing content", async () => {
    const listSkills = vi.fn(async () => [
      {
        id: 7,
        name: "我的研判技能",
        description: "只返回浏览所需信息",
        content: "不得返回到浏览器的提示词",
      },
    ]);
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }), listSkills);
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(
      `${baseUrl}/plugins/rabbitmq-consumer/debug/skills?user_id=${encodeURIComponent("42")}`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      skills: [{ id: 7, name: "我的研判技能", description: "只返回浏览所需信息" }],
    });
    expect(listSkills).toHaveBeenCalledWith("42");
  });

  it("requires a user id before querying MySQL skills", async () => {
    const listSkills = vi.fn(async () => []);
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }), listSkills);
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(`${baseUrl}/plugins/rabbitmq-consumer/debug/skills`, {
      headers: { cookie },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "user_id is required" });
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("reports MySQL skill lookup failures without leaking database details", async () => {
    const listSkills = vi.fn(async () => {
      throw new Error("mysql://user:secret@db.internal unavailable");
    });
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }), listSkills);
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(
      `${baseUrl}/plugins/rabbitmq-consumer/debug/skills?user_id=${encodeURIComponent("42")}`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "MySQL skills unavailable" });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
  });

  it("reports that MySQL skills are unavailable when no lookup is configured", async () => {
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }));
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(
      `${baseUrl}/plugins/rabbitmq-consumer/debug/skills?user_id=${encodeURIComponent("42")}`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "MySQL skills unavailable" });
  });

  it("rejects oversized MySQL user ids before querying", async () => {
    const listSkills = vi.fn(async () => []);
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }), listSkills);
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(
      `${baseUrl}/plugins/rabbitmq-consumer/debug/skills?user_id=${"x".repeat(129)}`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "user_id is invalid" });
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods on the MySQL skills endpoint", async () => {
    const baseUrl = await startHandler(async () => ({ response: "ok", events: [] }));
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(`${baseUrl}/plugins/rabbitmq-consumer/debug/skills`, {
      method: "POST",
      headers: { cookie },
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({ error: "Method not allowed" });
  });

  it("rejects invalid JSON on the simulated RabbitMQ endpoint", async () => {
    const run = vi.fn(async () => ({ response: "unused", events: [] }));
    const baseUrl = await startHandler(run);
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(`${baseUrl}/plugins/rabbitmq-consumer/debug/run`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before invoking the pipeline", async () => {
    const run = vi.fn(async () => ({ response: "unused", events: [] }));
    const baseUrl = await startHandler(run);
    const cookie = await openDebugSession(baseUrl);

    const response = await fetch(`${baseUrl}/plugins/rabbitmq-consumer/debug/run`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, message: "x".repeat(70_000) }),
    });

    expect(response.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });
});
