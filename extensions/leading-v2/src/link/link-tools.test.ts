import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { RecentTaskStore } from "../client/recent-tasks.js";
import type { PendingTaskRegistry } from "../notify/pending-store.js";
import type { NotifyConfig } from "../notify/types.js";
import type { RecentLinkBatch } from "./link-tools.js";

const NOTIFY_OFF: NotifyConfig = {
  enabled: false,
  pollIntervalMs: 5000,
  ttlMs: 7_200_000,
  maxPerTick: 5,
};
const NOTIFY_ON: NotifyConfig = {
  enabled: true,
  pollIntervalMs: 5000,
  ttlMs: 7_200_000,
  maxPerTick: 5,
};
const makeRegistry = () => ({ add: vi.fn() }) as unknown as PendingTaskRegistry;

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const {
  createLinkBatchCreateToolFactory,
  createLinkBatchListToolFactory,
  createLinkBatchStatusToolFactory,
} = await import("./link-tools.js");

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com", siteId: "legal" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);
const store = new RecentTaskStore<RecentLinkBatch>();
const createFactory = createLinkBatchCreateToolFactory(
  fakeApi,
  resolver,
  store,
  makeRegistry(),
  NOTIFY_OFF,
);
const statusFactory = createLinkBatchStatusToolFactory(fakeApi, resolver, store);
const listFactory = createLinkBatchListToolFactory(fakeApi, resolver);

function parse(result: unknown): Record<string, unknown> {
  const r = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (r?.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => vi.clearAllMocks());

describe("factory gating", () => {
  it("hides tools from non-rabbitmq agents", () => {
    expect(createFactory({ agentId: "telegram-1" })).toBeNull();
    expect(statusFactory({ agentId: undefined })).toBeNull();
    expect(listFactory({ agentId: "telegram-1" })).toBeNull();
  });

  it("exposes the tools to rabbitmq-<userId> agents", () => {
    expect(createFactory({ agentId: "rabbitmq-1749" })?.name).toBe("link_batch_create");
    expect(statusFactory({ agentId: "rabbitmq-1749" })?.name).toBe("link_batch_status");
    expect(listFactory({ agentId: "rabbitmq-1749" })?.name).toBe("link_batch_list");
  });
});

describe("link_batch_create", () => {
  const tool = () => createFactory({ agentId: "rabbitmq-1749" })!;

  it("normalizes links and posts /link/submit-offline-check-links, hiding the job id", async () => {
    mockPostForm.mockResolvedValue({ id: 30, message: "链接提交成功" });
    const res = parse(
      await tool().execute("c1", {
        links: ["https://a.com/1", " https://a.com/2 ", "https://a.com/1"],
        label: "测试批次",
      }),
    );
    expect(mockPostForm).toHaveBeenCalledTimes(1);
    const [, path, fields, apiKey] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(path).toBe("/link/submit-offline-check-links");
    expect(apiKey).toBe("sk_test1749");
    expect(fields).toMatchObject({
      label: "测试批次",
      data: ['{"link":"https://a.com/1"}', '{"link":"https://a.com/2"}'],
      fileUrl: "",
    });
    expect(res).toMatchObject({ success: true, submitted: true, label: "测试批次", linkCount: 2 });
    expect(res).not.toHaveProperty("status");
    expect(res).not.toHaveProperty("jobId");
  });

  it("accepts a newline-separated string and drops empty/invalid lines", async () => {
    mockPostForm.mockResolvedValue({ id: 31 });
    await tool().execute("c2", {
      links: "https://a.com/1\n\n not-a-url \n https://a.com/2 \n",
      label: "x",
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields.data).toEqual(['{"link":"https://a.com/1"}', '{"link":"https://a.com/2"}']);
  });

  it("drops URLs longer than the backend's varchar(1000) link column", async () => {
    mockPostForm.mockResolvedValue({ id: 32 });
    const tooLong = `https://a.com/${"x".repeat(1000)}`;
    await tool().execute("c2b", { links: [tooLong, "https://a.com/ok"], label: "x" });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields.data).toEqual(['{"link":"https://a.com/ok"}']);
  });

  it("errors without backend call when links or label missing", async () => {
    expect(parse(await tool().execute("c3", { links: "", label: "x" })).success).toBe(false);
    expect(parse(await tool().execute("c4", { links: "https://a.com/1", label: "" })).success).toBe(
      false,
    );
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("surfaces a backend danger envelope as an error", async () => {
    mockPostForm.mockResolvedValue({ code: "danger", message: "请上传链接" });
    const res = parse(await tool().execute("c5", { links: "https://a.com/1", label: "x" }));
    expect(res).toMatchObject({ success: false, error: "请上传链接" });
  });

  it("errors when the backend returns no job id", async () => {
    mockPostForm.mockResolvedValue({ message: "ok" });
    const res = parse(await tool().execute("c5b", { links: "https://a.com/1", label: "x" }));
    expect(res.success).toBe(false);
  });

  it("errors (no backend call) when no key resolves for the account", async () => {
    const noKey = createFactory({ agentId: "rabbitmq-2005" })!;
    const res = parse(await noKey.execute("c6", { links: "https://a.com/1", label: "x" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("registers the task for completion notification when a session + notify exist", async () => {
    const registry = makeRegistry();
    const tool = createLinkBatchCreateToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
      registry,
      NOTIFY_ON,
    )({ agentId: "rabbitmq-1749", sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1" })!;
    mockPostForm.mockResolvedValue({ id: 77 });

    await tool.execute("r1", { links: "https://a.com/1", label: "批次N" });

    expect(registry.add).toHaveBeenCalledTimes(1);
    expect((registry.add as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      id: "link_check:77",
      kind: "link_check",
      uid: "1749",
      backendId: "77",
      title: "批次N",
      sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
      notified: false,
    });
  });

  it("does not register when no session is available", async () => {
    const registry = makeRegistry();
    const tool = createLinkBatchCreateToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
      registry,
      NOTIFY_ON,
    )({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ id: 78 });

    await tool.execute("r2", { links: "https://a.com/1", label: "x" });

    expect(registry.add).not.toHaveBeenCalled();
  });
});

describe("link_batch_status", () => {
  it("polls the most recent job and derives per-link verdicts when done", async () => {
    const localStore = new RecentTaskStore<RecentLinkBatch>();
    const create = createLinkBatchCreateToolFactory(
      fakeApi,
      resolver,
      localStore,
      makeRegistry(),
      NOTIFY_OFF,
    )({
      agentId: "rabbitmq-1749",
    })!;
    const status = createLinkBatchStatusToolFactory(
      fakeApi,
      resolver,
      localStore,
    )({
      agentId: "rabbitmq-1749",
    })!;

    mockPostForm.mockResolvedValue({ id: 7001 });
    await create.execute("c1", { links: "https://a.com/1", label: "批次" });

    mockGetJson.mockImplementation(async (...args: unknown[]) => {
      const path = args[1] as string;
      if (path === "/link/fetch-link-status-job/7001") {
        return {
          code: "success",
          job: { status: "Done", linksTotal: 3, offlineTotal: "1", checkedTotal: "3" },
        };
      }
      // /link/fetch-link-status-results/7001
      return {
        code: "success",
        list: [
          { link: "https://a.com/2", offline: 0, memo: "", checked: 1 },
          { link: "https://a.com/1", offline: 1, memo: null, checked: 1 },
          { link: "https://a.com/3", offline: 0, memo: "页面无法打开", checked: 1 },
        ],
      };
    });
    const res = parse(await status.execute("s1", {}));

    const paths = mockGetJson.mock.calls.map((c) => (c as [unknown, string])[1]);
    expect(paths).toEqual([
      "/link/fetch-link-status-job/7001",
      "/link/fetch-link-status-results/7001",
    ]);

    expect(res).toMatchObject({
      success: true,
      status: "done",
      statusLabel: "已完成",
      done: true,
      label: "批次",
      linksTotal: 3,
      checkedTotal: 3,
      offlineTotal: 1,
      validTotal: 1,
      unknownTotal: 1,
      total: 3,
    });
    // Worst-first ordering so a truncated list never hides a dead link.
    const list = res.list as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({
      url: "https://a.com/1",
      verdict: "invalid",
      verdictLabel: "失效",
    });
    expect(list[1]).toMatchObject({
      url: "https://a.com/3",
      verdict: "unknown",
      verdictLabel: "无法判定",
      reason: "页面无法打开",
    });
    expect(list[2]).toMatchObject({ verdict: "valid", verdictLabel: "正常" });
    expect(res).not.toHaveProperty("jobId");
  });

  it("reports progress and skips the results fetch before anything is checked", async () => {
    const localStore = new RecentTaskStore<RecentLinkBatch>();
    localStore.remember("1749", { jobId: 55, label: "排队批次" });
    const status = createLinkBatchStatusToolFactory(
      fakeApi,
      resolver,
      localStore,
    )({
      agentId: "rabbitmq-1749",
    })!;

    mockGetJson.mockResolvedValue({
      job: { status: "Pending", linksTotal: 5, offlineTotal: "0", checkedTotal: "0" },
    });
    const res = parse(await status.execute("s2", {}));

    expect(mockGetJson).toHaveBeenCalledTimes(1);
    expect((mockGetJson.mock.calls[0] as [unknown, string])[1]).toBe(
      "/link/fetch-link-status-job/55",
    );
    expect(res).toMatchObject({
      success: true,
      status: "pending",
      statusLabel: "排队中",
      total: 0,
    });
    expect(res.list).toEqual([]);
    expect(res).not.toHaveProperty("done");
  });

  it("looks a task up by name when the user asks about an older batch", async () => {
    const status = createLinkBatchStatusToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
    )({ agentId: "rabbitmq-1749" })!;

    mockGetJson.mockImplementation(async (...args: unknown[]) => {
      const path = args[1] as string;
      if (path === "/link/fetch-link-status-jobs") {
        return { code: "success", list: [{ id: 12, label: "十月批次" }], total: 1 };
      }
      return { code: "success", job: { status: "Stop", linksTotal: 2, checkedTotal: "0" } };
    });
    const res = parse(await status.execute("s3", { label: "十月批次" }));

    const [, listPath, listQuery] = mockGetJson.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(listPath).toBe("/link/fetch-link-status-jobs");
    expect(listQuery).toMatchObject({ q: "十月批次" });
    expect((mockGetJson.mock.calls[1] as [unknown, string])[1]).toBe(
      "/link/fetch-link-status-job/12",
    );
    expect(res).toMatchObject({ success: true, status: "stop", stopped: true, label: "十月批次" });
  });

  it("errors when there is no recent task and no name is given", async () => {
    const status = createLinkBatchStatusToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
    )({ agentId: "rabbitmq-1749" })!;
    const res = parse(await status.execute("s4", {}));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});

describe("link_batch_list", () => {
  const tool = () => listFactory({ agentId: "rabbitmq-1749" })!;

  it("returns the account's task list without exposing ids", async () => {
    mockGetJson.mockResolvedValue({
      code: "success",
      total: 2,
      list: [
        {
          id: 30,
          label: "失效链接检测功能测试10-29",
          status: "Done",
          linksTotal: 7,
          date: "2025-10-29 18:07:27",
          updateDate: "2025-10-29 18:08:08",
          file: "https://oss/report.xlsx",
        },
        { id: 29, label: "旧批次", status: "Stop", linksTotal: 0, date: "2025-10-28 10:00:00" },
      ],
    });
    const res = parse(await tool().execute("l1", { page: 2, size: 5 }));

    const [, path, query] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/link/fetch-link-status-jobs");
    expect(query).toMatchObject({ page: 2, size: 5 });
    expect(res).toMatchObject({ success: true, total: 2, page: 2, size: 5 });
    const list = res.list as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({
      label: "失效链接检测功能测试10-29",
      status: "done",
      statusLabel: "已完成",
      linksTotal: 7,
      reportUrl: "https://oss/report.xlsx",
    });
    expect(list[1]).toMatchObject({ status: "stop", statusLabel: "已停止" });
    expect(list[0]).not.toHaveProperty("id");
  });

  it("clamps paging and surfaces backend errors", async () => {
    mockGetJson.mockResolvedValue({ code: "danger", message: "请登录" });
    const res = parse(await tool().execute("l2", { page: 0, size: 500 }));
    const [, , query] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(query).toMatchObject({ page: 1, size: 50 });
    expect(res).toMatchObject({ success: false, error: "请登录" });
  });
});
