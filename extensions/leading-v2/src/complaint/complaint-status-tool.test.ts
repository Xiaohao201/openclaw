import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";

const { mockGetJson } = vi.hoisted(() => ({
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", () => {
  class BackendApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }

  return {
    BackendApiError,
    getJson: mockGetJson,
    resolveConfig: () => ({
      baseUrl: "https://v2.businesstimescn.com",
      timeoutMs: 30_000,
      siteId: "legal",
      apiKeys: {},
    }),
  };
});

const { createComplaintTaskStatusToolFactory } = await import("./complaint-status-tool.js");

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

function parse(result: unknown): Record<string, unknown> {
  const value = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (value.details && typeof value.details === "object") {
    return value.details as Record<string, unknown>;
  }
  const text = value.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => vi.clearAllMocks());

describe("complaint_task_status", () => {
  const tool = () =>
    createComplaintTaskStatusToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;

  it("is hidden from non-rabbitmq agents", () => {
    expect(
      createComplaintTaskStatusToolFactory(fakeApi, resolver)({ agentId: "telegram-1" }),
    ).toBeNull();
  });

  it("lists recent complaint tasks with deterministic status summaries", async () => {
    mockGetJson.mockResolvedValue({
      code: "success",
      total: 2,
      list: [
        {
          id: 428,
          jobId: 0,
          status: "Done",
          date: "2026-09-01 15:08:47",
          updateDate: "2026-09-01 15:10:00",
          links: '["https://www.douyin.com/video/1"]',
          reason: "已核实违规内容",
          linkTotal: 1,
          doneCount: 1,
          stopCount: 0,
          progressCount: 0,
          offlineCount: 1,
          linkItems: [
            {
              id: 5458,
              link: "https://www.douyin.com/video/1",
              title: "测试视频",
              author: "测试账号",
              platform: "Douyin",
            },
          ],
        },
        {
          id: 427,
          jobId: 0,
          status: "Pending",
          date: "2026-09-01 14:00:00",
          links: '["https://weibo.com/1/a"]',
          linkTotal: 1,
          doneCount: 0,
          stopCount: 0,
          progressCount: 1,
          offlineCount: 0,
        },
      ],
      stats: { totalTasks: 2, progressTasks: 1, doneTasks: 1, offlineCount: 1 },
      platformDist: [
        { platform: "Weibo", total: 1, offline: 0 },
        { platform: "Douyin", total: 1, offline: 1 },
      ],
    });

    const result = parse(await tool().execute("status-list", { page: 1, size: 5 }));

    expect(mockGetJson).toHaveBeenCalledWith(
      expect.anything(),
      "/legal/fetch-complaint-tasks",
      { page: 1, size: 5, q: undefined },
      "sk_test1749",
    );
    expect(result).toMatchObject({ success: true, mode: "list", total: 2 });
    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: 428,
        state: "done",
        links: ["https://www.douyin.com/video/1"],
        offlineCount: 1,
      }),
      expect.objectContaining({ id: 427, state: "pending", progressCount: 1 }),
    ]);
    expect(result.platforms).toEqual([
      { platform: "Douyin", total: 1, offline: 1 },
      { platform: "Weibo", total: 1, offline: 0 },
    ]);
  });

  it("returns per-link submission and takedown state for one task", async () => {
    mockGetJson.mockResolvedValue({
      code: "success",
      list: [
        {
          id: 5460,
          taskId: 429,
          link: "https://weibo.com/1/b",
          title: "第二条",
          author: "账号乙",
          platform: "Weibo",
          status: "Stop",
          submissionStatus: "Stop",
          failureReason: "登录态失效",
          offline: 0,
          offlineCheckDate: "2026-09-02 12:00:00",
          updateDate: "2026-09-02 12:05:00",
        },
        {
          id: 5459,
          taskId: 429,
          link: "https://weibo.com/1/a",
          title: "第一条",
          author: "账号甲",
          platform: "Weibo",
          status: "Done",
          submissionStatus: "Done",
          failureReason: "",
          offline: 1,
          offlineCheckDate: "2026-09-02 12:01:00",
          updateDate: "2026-09-02 12:04:00",
        },
      ],
    });

    const result = parse(await tool().execute("status-detail", { taskId: 429 }));

    expect(mockGetJson).toHaveBeenCalledWith(
      expect.anything(),
      "/legal/fetch-complaints/429",
      {},
      "sk_test1749",
    );
    expect(result).toMatchObject({
      success: true,
      mode: "detail",
      taskId: 429,
      summary: { total: 2, submitted: 1, stopped: 1, failed: 0, processing: 0, offline: 1 },
    });
    expect(result.complaints).toEqual([
      expect.objectContaining({ id: 5460, state: "stopped", failureReason: "登录态失效" }),
      expect.objectContaining({ id: 5459, state: "done", offline: true }),
    ]);
  });

  it("rejects an invalid task id without calling the backend", async () => {
    const result = parse(await tool().execute("status-invalid", { taskId: 0 }));

    expect(result).toMatchObject({ success: false });
    expect(String(result.error)).toContain("taskId");
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("does not claim a queued task when the visible task list is empty", async () => {
    mockGetJson.mockResolvedValue({
      code: "success",
      total: 0,
      list: [],
      stats: { totalTasks: 0 },
      platformDist: [],
    });

    const result = parse(await tool().execute("status-empty", {}));

    expect(result).toMatchObject({ success: true, mode: "list", total: 0, tasks: [] });
    expect(String(result.agentInstruction)).toContain("禁止声称");
  });

  it("normalizes legacy states and malformed task fields safely", async () => {
    mockGetJson.mockResolvedValue({
      code: "success",
      total: "7",
      list: [
        { id: 7, status: "Processing", links: ["https://example.com/7", null, 8] },
        { id: 6, status: "Completed", links: "not-json" },
        { id: 5, status: "Success", links: "{}" },
        { id: 4, status: "Fail", links: "" },
        { id: 3, status: "Failed", links: null },
        { id: 2, status: "Stopped", linkItems: [null, { id: "not-a-number" }] },
        { id: 1, status: "unexpected" },
      ],
      stats: null,
      platformDist: [null, { platform: null, total: "bad", offline: "1" }],
    });

    const result = parse(
      await tool().execute("status-compat", { page: -2, size: 200, q: "  示例  " }),
    );
    const tasks = result.tasks as Array<{ state: string; links: string[] }>;

    expect(mockGetJson).toHaveBeenCalledWith(
      expect.anything(),
      "/legal/fetch-complaint-tasks",
      { page: 1, size: 20, q: "示例" },
      "sk_test1749",
    );
    expect(tasks.map((item) => item.state)).toEqual([
      "running",
      "done",
      "done",
      "failed",
      "failed",
      "stopped",
      "unknown",
    ]);
    expect(tasks[0]?.links).toEqual(["https://example.com/7"]);
  });

  it("uses detail fallbacks and counts every nonterminal state as processing", async () => {
    mockGetJson.mockResolvedValue({
      list: [
        { id: 4, status: "Failed", memo: "平台拒绝", offline: "0" },
        { id: 3, submissionStatus: "Processing", offline: 0 },
        { id: 2, submissionStatus: "mystery", offline: 0 },
        { id: 1, submissionStatus: "Pending", offline: 0 },
      ],
    });

    const result = parse(await tool().execute("status-detail-fallback", { taskId: 8 }));

    expect(result).toMatchObject({
      success: true,
      summary: { total: 4, submitted: 0, stopped: 0, failed: 1, processing: 3, offline: 0 },
    });
    expect(result.complaints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 4, state: "failed", failureReason: "平台拒绝" }),
      ]),
    );
  });

  it("returns backend business errors without inventing task state", async () => {
    mockGetJson.mockResolvedValue({ code: "forbidden", message: "无权查看该任务" });

    const result = parse(await tool().execute("status-forbidden", { taskId: 9 }));

    expect(result).toEqual(expect.objectContaining({ success: false, error: "无权查看该任务" }));
  });

  it("converts transport failures into a tool failure", async () => {
    mockGetJson.mockRejectedValue(new Error("network unavailable"));

    const result = parse(await tool().execute("status-network", {}));

    expect(result).toEqual(expect.objectContaining({ success: false }));
  });

  it("does not call the backend when the current user has no API key", async () => {
    const missingKeyTool = createComplaintTaskStatusToolFactory(
      fakeApi,
      resolver,
    )({
      agentId: "rabbitmq-999",
    })!;

    const result = parse(await missingKeyTool.execute("status-no-key", {}));

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
