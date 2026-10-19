import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { createComplaintSubmitToolFactory } from "../ai/ai-tools.js";
import { execute as executeDb } from "../client/db-client.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { stopLocalComplaints, waitForLocalBatch } from "./complaint-local.js";
import { createComplaintTaskStatusToolFactory } from "./complaint-status-tool.js";
import { createComplaintTaxonomyToolFactory } from "./complaint-taxonomy-tool.js";

let root: string;
let api: OpenClawPluginApi;
const parse = (value: unknown) => (value as { details: Record<string, unknown> }).details;
const resolver = new ApiKeyResolver({}, undefined);
const { acquireBrowser } = vi.hoisted(() => ({ acquireBrowser: vi.fn() }));
const nativeRun = vi.hoisted(() => vi.fn());
vi.mock("./executor/native.runtime.js", () => ({ runNativeComplaint: nativeRun }));
vi.mock("../client/db-client.js", () => ({ execute: vi.fn(), query: vi.fn() }));
// Transport fixture: session ownership and stale-tab behavior are exercised in
// complaint-session-handoff.test.ts; this suite checks batch/process plumbing.
vi.mock("./complaint-session-handoff.js", () => ({
  sessionBrowserHandoffs: () => ({ acquire: acquireBrowser }),
}));
beforeEach(async () => {
  vi.mocked(executeDb).mockReset();
  vi.mocked(executeDb).mockResolvedValue({ insertId: 101, affectedRows: 1 } as Awaited<
    ReturnType<typeof executeDb>
  >);
  acquireBrowser.mockReset().mockResolvedValue({
    handoff: {
      version: 1,
      targetId: "fixture",
      marker: "12345678-1234-1234-1234-123456789abc",
      binding: {},
    },
    release() {},
  });
  root = await mkdtemp(join(tmpdir(), "complaint-tool-"));
  nativeRun.mockReset().mockImplementation(async ({ item }) => {
    expect(item.platform).toBe("weibo");
    expect(item.reason).toMatch(/测试。$/);
    return { state: "done", message: "confirmed fixture", offline: null };
  });
  api = {
    pluginConfig: {
      complaintExecution: { runtimeDir: root },
      backend: {
        db: {
          host: "db.example.test",
          port: 3306,
          user: "fixture",
          password: "fixture",
          database: "fixture",
        },
      },
    },
    runtime: { state: { resolveStateDir: () => root } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as OpenClawPluginApi;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Backend access forbidden")));
});
afterEach(async () => {
  await stopLocalComplaints();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("local tool integration", () => {
  it("explains the Douyin limit without recording a task or acquiring a browser", async () => {
    const link = "https://www.douyin.com/video/123456789";
    const tool = createComplaintSubmitToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(
      await tool.execute("submit", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Enterprise",
        judgment: "测".repeat(350),
        links: [link],
        categories: [{ link, category: "不实信息" }],
      }),
    );
    expect(result).toMatchObject({
      success: false,
      submitted: false,
      error: expect.stringContaining("200"),
    });
    expect(executeDb).not.toHaveBeenCalled();
    expect(acquireBrowser).not.toHaveBeenCalled();
    expect(nativeRun).not.toHaveBeenCalled();
  });
  it("records a task before native execution without Python runtime assets", async () => {
    const tool = createComplaintSubmitToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(
      await tool.execute("submit", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Enterprise",
        judgment: "依据这条链接的原始内容和用户提供的具体证据进行本地测试。",
        links: ["https://weibo.com/1/2"],
      }),
    );
    expect(result).toMatchObject({
      success: true,
      accepted: true,
      submitted: false,
    });
    expect(result.batchId).toEqual(expect.any(String));
    expect(result.taskId).toBe(101);
    await waitForLocalBatch(result.batchId as string);
    expect(nativeRun).toHaveBeenCalledOnce();
    expect(vi.mocked(executeDb).mock.invocationCallOrder[0]).toBeLessThan(
      nativeRun.mock.invocationCallOrder[0],
    );
    expect(executeDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("INSERT INTO legal_complaint_task"),
      expect.any(Array),
    );
    const status = createComplaintTaskStatusToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    expect(parse(await status.execute("list", {})).total).toBe(1);
    expect(parse(await status.execute("status", { batchId: result.batchId })).links).toEqual([
      expect.objectContaining({ taskId: 101, state: "done" }),
    ]);
    expect(acquireBrowser).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs from the original tool entry without an API key and reads only the owning user's status", async () => {
    const factory = createComplaintSubmitToolFactory(api, resolver);
    expect(factory({ agentId: "untrusted" })).toBeNull();
    const result = parse(
      await factory({ agentId: "rabbitmq-1" })!.execute("submit", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment: "依据这条链接的原始内容和用户提供的具体证据进行本地测试。",
        links: ["https://weibo.com/1/2"],
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.taskId).toBe(101);
    expect(result.submitted).toBe(false);
    await waitForLocalBatch(result.batchId as string);
    const status = createComplaintTaskStatusToolFactory(api, resolver);
    const owned = parse(
      await status({ agentId: "rabbitmq-1" })!.execute("status", { batchId: result.batchId }),
    );
    expect(owned.summary).toMatchObject({ submitted: 1, unknown: 0 });
    const byTaskId = parse(
      await status({ agentId: "rabbitmq-1" })!.execute("task", { taskId: result.taskId }),
    );
    expect(byTaskId.batchId).toBe(result.batchId);
    expect(byTaskId.summary).toMatchObject({ submitted: 1 });
    expect(
      parse(await status({ agentId: "rabbitmq-2" })!.execute("status", { batchId: result.batchId }))
        .success,
    ).toBe(false);
    expect(parse(await status({ agentId: "rabbitmq-1" })!.execute("list", {})).total).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exposes local capabilities without querying the backend", async () => {
    const tool = createComplaintTaxonomyToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(
      await tool.execute("catalog", { links: ["https://weibo.com/1", "https://localhost/"] }),
    );
    expect(result.executor).toBe("local");
    expect(result.unsupportedLinks).toEqual(["https://localhost/"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits unavailable platforms and does not route WeChat to Tencent", async () => {
    const links = [
      "https://www.10jqka.com.cn/1",
      "https://xueqiu.com/1",
      "https://mp.weixin.qq.com/s/1",
    ];
    const tool = createComplaintTaxonomyToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(await tool.execute("catalog", { links }));
    expect(result.unsupportedLinks).toEqual(links);
    expect(result.platforms).not.toEqual(expect.arrayContaining(["wechat"]));
    expect(result.platforms).not.toEqual(expect.arrayContaining(["tonghuashun"]));
    expect(result.platforms).not.toEqual(expect.arrayContaining(["xueqiu"]));
    expect(result.platforms).toContain("tencent");
    expect(result.platforms).not.toContain("report12377");
    expect(result.links).toEqual(links.map((link) => ({ link, platform: null })));
  });

  it("keeps a failed browser handoff traceable without suggesting another channel", async () => {
    acquireBrowser.mockRejectedValue(new Error("No owned browser tab"));
    const tool = createComplaintSubmitToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(
      await tool.execute("submit", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment: "依据这条链接的原始内容和用户提供的具体证据进行本地测试。",
        links: ["https://weibo.com/1/2"],
      }),
    );
    expect(result).toMatchObject({
      taskId: 101,
      submitted: false,
      errorCode: "BROWSER_HANDOFF_REQUIRED",
    });
    expect(result.agentInstruction).toContain("不得推荐或切换到12377");
    const status = createComplaintTaskStatusToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    expect(parse(await status.execute("status", { batchId: result.batchId })).links).toEqual([
      expect.objectContaining({
        taskId: 101,
        state: "manual_required",
        errorCode: "BROWSER_HANDOFF_REQUIRED",
      }),
    ]);
    expect(vi.mocked(executeDb).mock.invocationCallOrder[0]).toBeLessThan(
      acquireBrowser.mock.invocationCallOrder[0],
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not acquire a browser or execute when task recording fails", async () => {
    vi.mocked(executeDb).mockRejectedValue(new Error("db unavailable"));
    const tool = createComplaintSubmitToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(
      await tool.execute("submit", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment: "依据这条链接的原始内容和用户提供的具体证据进行本地测试。",
        links: ["https://weibo.com/1/2"],
      }),
    );
    expect(result).toMatchObject({
      accepted: false,
      submitted: false,
      errorCode: "TASK_RECORD_FAILED",
    });
    expect(result.batchId).toEqual(expect.any(String));
    expect(acquireBrowser).not.toHaveBeenCalled();
    expect(executeDb).toHaveBeenCalledTimes(1);
  });

  it("retains an explicit sync error when the database checkpoint fails", async () => {
    vi.mocked(executeDb)
      .mockResolvedValueOnce({ insertId: 101, affectedRows: 1 } as Awaited<
        ReturnType<typeof executeDb>
      >)
      .mockRejectedValue(new Error("database unavailable"));
    const tool = createComplaintSubmitToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const result = parse(
      await tool.execute("submit", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment: "依据这条链接的原始内容和用户提供的具体证据进行本地测试。",
        links: ["https://weibo.com/1/2"],
      }),
    );
    await waitForLocalBatch(result.batchId as string);
    const status = createComplaintTaskStatusToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    const resultStatus = parse(await status.execute("status", { batchId: result.batchId }));
    expect(resultStatus.persistenceError).toBe("TASK_RECORD_SYNC_FAILED");
    expect(resultStatus.summary).toMatchObject({ submitted: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
