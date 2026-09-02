import { describe, expect, it, vi } from "vitest";
import {
  ToolActivityNarrator,
  resolveStepDetail,
  resolveToolCategory,
  resolveToolLabel,
  type ActivityStep,
} from "./tool-activity.js";

describe("resolveToolLabel", () => {
  it("maps known tools to user-facing labels", () => {
    expect(resolveToolLabel("exec")).toBe("正在查询分析数据");
    expect(resolveToolLabel("Read")).toBe("正在查阅资料");
    expect(resolveToolLabel("web_search")).toBe("正在检索网络信息");
    expect(resolveToolLabel("video_link_parse")).toBe("正在解析视频链接");
  });

  it("falls back to a generic label for unknown tools", () => {
    expect(resolveToolLabel("some_plugin_tool")).toBe("正在执行处理步骤");
    expect(resolveToolLabel("")).toBe("正在执行处理步骤");
  });

  it("maps the expanded plugin tools instead of the generic fallback", () => {
    expect(resolveToolLabel("feed_list")).toBe("正在浏览舆情列表");
    expect(resolveToolLabel("schedule_create")).toBe("正在创建定时任务");
    expect(resolveToolLabel("letter_generate")).toBe("正在生成维权文书");
    expect(resolveToolLabel("complaint_task_status")).toBe("正在查询举报任务状态");
    expect(resolveToolLabel("link_batch_create")).toBe("正在发起失效链接检测");
  });

  it("gives write and edit distinct labels (no shared 整理内容)", () => {
    expect(resolveToolLabel("write")).toBe("正在撰写内容");
    expect(resolveToolLabel("edit")).toBe("正在修改内容");
    expect(resolveToolLabel("apply_patch")).toBe("正在修改内容");
  });
});

describe("resolveToolCategory", () => {
  it("maps known tools to sanitized categories", () => {
    expect(resolveToolCategory("exec")).toBe("query");
    expect(resolveToolCategory("Read")).toBe("read");
    expect(resolveToolCategory("edit")).toBe("write");
    expect(resolveToolCategory("web_fetch")).toBe("search");
    expect(resolveToolCategory("memory_search")).toBe("memory");
    expect(resolveToolCategory("video_link_parse")).toBe("search");
  });

  it("falls back to the default category for unknown tools", () => {
    expect(resolveToolCategory("some_plugin_tool")).toBe("default");
    expect(resolveToolCategory("")).toBe("default");
  });

  it("maps expanded tools onto sanitized categories", () => {
    expect(resolveToolCategory("schedule_create")).toBe("schedule");
    expect(resolveToolCategory("link_batch_create")).toBe("check");
    expect(resolveToolCategory("opinion_report_export")).toBe("report");
    expect(resolveToolCategory("complaint_task_status")).toBe("query");
    expect(resolveToolCategory("x_search")).toBe("search");
  });
});

describe("resolveStepDetail", () => {
  it("derives a count detail from whitelisted array args", () => {
    expect(resolveStepDetail("legal_check_create", { links: ["a", "b", "c"] })).toBe("检测 3 项");
    expect(resolveStepDetail("link_batch_create", { urls: ["x"] })).toBe("检测 1 条链接");
    expect(resolveStepDetail("feed_query", { limit: 20 })).toBe("获取 20 条");
  });

  it("maps a report period enum to a fixed label", () => {
    expect(resolveStepDetail("report_create", { period: "weekly" })).toBe("周报");
    expect(resolveStepDetail("sheet_report_create", { type: "MONTHLY" })).toBe("月报");
  });

  it("returns undefined for non-whitelisted tools", () => {
    expect(resolveStepDetail("exec", { command: "SELECT 1" })).toBeUndefined();
    expect(resolveStepDetail("write", { content: "secret" })).toBeUndefined();
  });

  it("never derives a detail from free-text args (no leak)", () => {
    // feed_query only reads numeric limit-like keys; free text is ignored.
    expect(
      resolveStepDetail("feed_query", { sql: "SELECT secret FROM users", keyword: "内部代号X" }),
    ).toBeUndefined();
    // An enum field carrying arbitrary text is not in the fixed map → dropped.
    expect(
      resolveStepDetail("report_create", { period: "internal-codename-leak" }),
    ).toBeUndefined();
  });
});

describe("ToolActivityNarrator", () => {
  function createNarrator(minIntervalMs = 2000) {
    let nowMs = 0;
    const pushed: string[] = [];
    const steps: ActivityStep[] = [];
    const narrator = new ToolActivityNarrator({
      push: (message) => pushed.push(message),
      onStep: (step) => steps.push(step),
      minIntervalMs,
      now: () => nowMs,
    });
    return { narrator, pushed, steps, advance: (ms: number) => (nowMs += ms) };
  }

  it("pushes a sanitized status line on tool start, never leaking args", () => {
    const { narrator, pushed } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "exec",
        args: { command: "mysql -uroot -pSECRET -e 'SELECT * FROM feed_monitor_item'" },
      },
    });
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…"]);
    expect(pushed[0]).not.toContain("SECRET");
    expect(pushed[0]).not.toContain("SELECT");
  });

  it("ignores non-tool streams and non-start phases", () => {
    const { narrator, pushed } = createNarrator();
    narrator.handleAgentEvent({ stream: "assistant", data: { delta: "hi" } });
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "update", name: "exec" } });
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "end", name: "exec" } });
    narrator.handleAgentEvent({ stream: "tool" });
    expect(pushed).toEqual([]);
  });

  it("collapses same-label bursts within minIntervalMs", () => {
    const { narrator, pushed, advance } = createNarrator(2000);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    advance(500);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    advance(2000);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    // Collapsed events do not consume step numbers — they stay contiguous.
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…", "正在查询分析数据（第 2 步）…"]);
  });

  it("pushes immediately when the tool kind changes", () => {
    const { narrator, pushed, advance } = createNarrator(2000);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    advance(100);
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "read" } });
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…", "正在查阅资料（第 2 步）…"]);
  });

  it("uses Date.now by default without throwing", () => {
    const push = vi.fn();
    const narrator = new ToolActivityNarrator({ push });
    narrator.handleAgentEvent({ stream: "tool", data: { phase: "start", name: "exec" } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("emits a structured start step with sanitized label and category", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tc-1",
        args: { command: "SELECT secret FROM users" },
      },
    });
    expect(steps).toEqual([
      {
        phase: "start",
        stepId: "tc-1",
        index: 1,
        label: "正在查询分析数据",
        category: "query",
        status: "running",
      },
    ]);
    expect(JSON.stringify(steps)).not.toContain("secret");
  });

  it("pairs start/end by stepId and computes duration", () => {
    const { narrator, steps, advance } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tc-9" },
    });
    advance(1500);
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "read", toolCallId: "tc-9", status: "completed" },
    });
    expect(steps).toEqual([
      {
        phase: "start",
        stepId: "tc-9",
        index: 1,
        label: "正在查阅资料",
        category: "read",
        status: "running",
      },
      {
        phase: "end",
        stepId: "tc-9",
        index: 1,
        label: "正在查阅资料",
        category: "read",
        status: "completed",
        durationMs: 1500,
      },
    ]);
  });

  it("turns a feed_list result into useful public data instead of a generic completion", () => {
    const { narrator, steps, advance } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "feed_list",
        toolCallId: "feed-1",
        args: { topicId: 553, page: 1, size: 1, apiKey: "SECRET" },
      },
    });
    advance(420);
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "feed_list",
        toolCallId: "feed-1",
        isError: false,
        result: {
          details: {
            success: true,
            total: 18,
            list: [
              {
                title: "深圳某项目施工进展",
                platform: "微信",
                date: "2026-08-28",
                level: "高",
                emotion: "负面",
                summary: "公众关注施工噪声及夜间作业问题。",
                link: "https://example.com/private-link",
              },
            ],
          },
        },
      },
    });

    expect(steps).toEqual([
      expect.objectContaining({
        phase: "start",
        publicNarrative: ["我会读取 topicId=553 的第 1 页，每页 1 条舆情。"],
      }),
      expect.objectContaining({
        phase: "end",
        status: "completed",
        durationMs: 420,
        publicNarrative: [
          "我会读取 topicId=553 的第 1 页，每页 1 条舆情。",
          "接口报告共有 18 条匹配，本次返回 1 条。",
          "其中一条是《深圳某项目施工进展》（微信，2026-08-28，风险等级高，情感负面）。",
          "它的摘要是：“公众关注施工噪声及夜间作业问题。”",
        ],
      }),
    ]);
    expect(JSON.stringify(steps)).not.toContain("SECRET");
    expect(JSON.stringify(steps)).not.toContain("private-link");
  });

  it("shows bounded Milvus matches without exposing the query or collection", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "milvus_search",
        toolCallId: "milvus-1",
        args: { query: "private search wording", collection: "internal_collection", topK: 3 },
      },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "milvus_search",
        toolCallId: "milvus-1",
        result: {
          details: {
            success: true,
            collection: "internal_collection",
            matches: [
              { score: 0.9234, text: "历史周报先概述风险，再按事件展开事实与建议。" },
              { score: 0.81, text: "第二条历史资料。" },
            ],
          },
        },
      },
    });

    expect(steps[1]).toMatchObject({
      phase: "end",
      publicNarrative: [
        "我会检索最多 3 条相关历史资料，用来参考已有表达和事实。",
        "语义检索返回 2 条历史资料。",
        "最相关的资料相似度为 0.923，内容摘要是：“历史周报先概述风险，再按事件展开事实与建议。”",
      ],
    });
    expect(JSON.stringify(steps)).not.toContain("private search wording");
    expect(JSON.stringify(steps)).not.toContain("internal_collection");
  });

  it("does not expose raw tool errors in public result narration", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "feed_list",
        toolCallId: "feed-failed",
        args: { topicId: 553, size: 1 },
      },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "feed_list",
        toolCallId: "feed-failed",
        isError: true,
        result: { details: { success: false, error: "token=SECRET at C:/internal/config.json" } },
      },
    });

    expect(steps[1]).toMatchObject({
      phase: "end",
      status: "failed",
      publicNarrative: [
        "我会读取 topicId=553 的第 1 页，每页 1 条舆情。",
        "数据接口没有返回可用结果。",
      ],
    });
    expect(JSON.stringify(steps)).not.toContain("SECRET");
    expect(JSON.stringify(steps)).not.toContain("config.json");
  });

  it("uses explicit startedAt/endedAt timestamps for duration when present", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "tc-2", startedAt: 1000 },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "exec", toolCallId: "tc-2", startedAt: 1000, endedAt: 3200 },
    });
    expect(steps[1]).toMatchObject({ phase: "end", durationMs: 2200, status: "completed" });
  });

  it("maps a failed end status to a failed step", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "tc-3" },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "exec", toolCallId: "tc-3", status: "failed" },
    });
    expect(steps[1]).toMatchObject({ phase: "end", status: "failed" });
  });

  it("does not collapse structured steps even when the string line is collapsed", () => {
    const { narrator, pushed, steps } = createNarrator(2000);
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "a" },
    });
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "b" },
    });
    // String push collapses the same-label burst into one line...
    expect(pushed).toEqual(["正在查询分析数据（第 1 步）…"]);
    // ...but each tool call still gets its own structured start step.
    expect(steps.map((s) => s.stepId)).toEqual(["a", "b"]);
  });

  it("attaches a safe detail to the start and end steps for whitelisted tools", () => {
    const { narrator, steps, advance } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "legal_check_create",
        toolCallId: "lc-1",
        args: { links: ["a", "b"] },
      },
    });
    advance(900);
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "legal_check_create", toolCallId: "lc-1", status: "completed" },
    });
    expect(steps[0]).toMatchObject({ phase: "start", detail: "检测 2 项" });
    expect(steps[1]).toMatchObject({ phase: "end", detail: "检测 2 项", durationMs: 900 });
  });

  it("emits no detail and leaks nothing for free-text tool args", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "e-1",
        args: { command: "mysql -pSECRET -e 'SELECT * FROM feed_monitor_item'" },
      },
    });
    expect(steps[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(steps)).not.toContain("SECRET");
    expect(JSON.stringify(steps)).not.toContain("SELECT");
  });

  it("ignores an end with no matching start (no phantom step)", () => {
    const { narrator, steps } = createNarrator();
    narrator.handleAgentEvent({
      stream: "tool",
      data: { phase: "end", name: "exec", toolCallId: "ghost", status: "completed" },
    });
    expect(steps).toEqual([]);
  });
});
