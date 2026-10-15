import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComplaintBatchStore } from "./complaint-batch-store.js";
import { parseLocalRequest, resolveLocalConfig } from "./complaint-local-contract.js";
import {
  queryLocalBatch,
  stopLocalComplaints,
  submitLocalBatch,
  waitForLocalBatch,
} from "./complaint-local.js";

let root: string;
let store: ComplaintBatchStore;
const reason = "根据原文和用户提供的证据，该链接存在明确事实错误，请平台核查。";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "local-complaint-"));
  store = new ComplaintBatchStore(() => root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const request = (links = ["https://weibo.com/1/2"]) => ({
  basisSource: "AgentJudgment",
  confirmed: true,
  subjectScope: "Institution",
  judgment: reason,
  links,
});

describe("direct local reporting", () => {
  it.each([
    ["baidu", "https://baijiahao.baidu.com/s?id=123456"],
    ["bilibili", "https://www.bilibili.com/video/BV1testfixture"],
    ["douyin", "https://www.douyin.com/video/1234567890123456789"],
    ["eastmoney", "https://finance.eastmoney.com/a/123456.html"],
    ["futu", "https://q.futunn.com/feed/123456789012345"],
    ["kuaishou", "https://www.kuaishou.com/short-video/test-fixture"],
    ["netease", "https://www.163.com/dy/article/TESTFIXTURE.html"],
    ["sina", "https://news.sina.com.cn/c/2026-01-01/doc-imtest123456.shtml"],
    ["sohu", "https://www.sohu.com/a/123456_654321"],
    ["tencent", "https://news.qq.com/rain/a/TESTFIXTURE"],
    ["tiantianfund", "https://fund.eastmoney.com/ba/news,of000001,123456.html"],
    ["toutiao", "https://www.toutiao.com/article/123456/"],
    ["weibo", "https://weibo.com/123456/testfixture"],
    ["yidianzixun", "https://www.yidianzixun.com/article/TESTFIXTURE"],
    ["zhihu", "https://www.zhihu.com/question/123/answer/456"],
  ])("routes and persists a simulated %s report", async (platform, link) => {
    const run = vi.fn().mockResolvedValue({
      state: "done",
      message: "Offline fixture receipt",
      offline: null,
    });
    const result = await submitLocalBatch({
      store,
      userId: "offline-platform-test",
      items: parseLocalRequest(request([link])),
      config: resolveLocalConfig({}),
      run,
    });
    expect(result.submitted).toBe(false);
    await waitForLocalBatch(result.batchId);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ item: expect.objectContaining({ platform, link, reason }) }),
    );
    const batch = await store.get("offline-platform-test", result.batchId);
    expect(queryLocalBatch(batch!).links).toEqual([
      expect.objectContaining({ link, state: "done", submissionStatus: "Done" }),
    ]);
    expect(await store.get("other-user", result.batchId)).toBeNull();
  });

  it("marks remaining links stopped after a manual intervention, including older pending batches", async () => {
    const links = ["https://weibo.com/1", "https://weibo.com/2"];
    const run = vi.fn().mockResolvedValue({
      state: "manual_required",
      message: "Login required",
      offline: null,
      errorCode: "LOGIN_REQUIRED",
    });
    const result = await submitLocalBatch({
      store,
      userId: "1",
      items: parseLocalRequest({
        ...request(links),
        linkJudgments: links.map((link) => ({ link, judgment: reason })),
      }),
      config: resolveLocalConfig({}),
      run,
    });
    await waitForLocalBatch(result.batchId);
    const batch = (await store.get("1", result.batchId))!;
    expect(run).toHaveBeenCalledTimes(1);
    expect(queryLocalBatch(batch).links[1]).toMatchObject({
      state: "not_submitted",
      failureReason: expect.stringContaining("不会自动继续"),
    });
    batch.entries[1].execution = { state: "pending", message: "本地等待执行", offline: null };
    expect(queryLocalBatch(batch).links[1].failureReason).toContain("不会自动继续");
  });

  it.each([
    "https://www.10jqka.com.cn/article/1",
    "https://xueqiu.com/1/2",
    "https://mp.weixin.qq.com/s/example",
  ])("rejects unavailable direct reporting platform: %s", (link) => {
    expect(() => parseLocalRequest(request([link]))).toThrow();
  });

  it("routes the current XHS app share domain without accepting lookalikes", () => {
    expect(parseLocalRequest(request(["https://xhslink.cn/o/test-note"]))[0].platform).toBe(
      "xiaohongshu",
    );
    expect(() => parseLocalRequest(request(["https://xhslink.cn.example.test/o/note"]))).toThrow();
  });
  it("requires an explicit phone owner and serial binding", () => {
    expect(() => resolveLocalConfig({ complaintExecution: { phone: {} } })).toThrow();
    expect(
      resolveLocalConfig({
        complaintExecution: { phone: { serial: "test-device", userId: "test-user" } },
      }).phone,
    ).toEqual({ adbPath: "adb", serial: "test-device", userId: "test-user" });
    expect(resolveLocalConfig({}).phone).toBeUndefined();
  });
  it("stops queued batches on service shutdown", async () => {
    const run = vi.fn();
    const result = await submitLocalBatch({
      store,
      userId: "1",
      items: parseLocalRequest(request()),
      config: resolveLocalConfig({}),
      run,
    });
    await stopLocalComplaints();
    expect(run).not.toHaveBeenCalled();
    expect(queryLocalBatch((await store.get("1", result.batchId))!).summary.notSubmitted).toBe(1);
  });

  it.each([3, 4])("preserves conservative state on checkpoint failure %s", async (failureAt) => {
    const save = store.save.bind(store);
    let calls = 0;
    vi.spyOn(store, "save").mockImplementation(async (batch) => {
      if (++calls === failureAt) {
        throw new Error("disk full");
      }
      await save(batch);
    });
    const run = vi.fn().mockResolvedValue({ state: "done", message: "confirmed", offline: null });
    const result = await submitLocalBatch({
      store,
      userId: "1",
      items: parseLocalRequest(request()),
      config: resolveLocalConfig({}),
      run,
    });
    await waitForLocalBatch(result.batchId);
    const status = queryLocalBatch((await store.get("1", result.batchId))!);
    expect(status.summary.submitted).toBe(0);
    expect(run).toHaveBeenCalledTimes(failureAt === 3 ? 0 : 1);
    expect(failureAt === 3 ? status.summary.notSubmitted : status.summary.unknown).toBe(1);
  });
  it("requires the official anonymous payload limits", () => {
    expect(
      parseLocalRequest({
        ...request(["https://example.test/article"]),
        report12377: { category: "rumor", websiteName: "Example" },
      })[0].platform,
    ).toBe("report12377");
    expect(() =>
      parseLocalRequest({
        ...request(),
        judgment: "x".repeat(501),
        report12377: { category: "rumor", websiteName: "Example" },
      }),
    ).toThrow();
    expect(() =>
      parseLocalRequest({
        ...request(),
        categories: [{ link: "https://example.test/other", category: "不实信息" }],
      }),
    ).toThrow();
    expect(() =>
      resolveLocalConfig({ complaintExecution: { runtimeDir: "relative/path" } }),
    ).toThrow();
  });
  it("requires confirmation, independent reasons, and supported public URLs", () => {
    expect(() => parseLocalRequest({ ...request(), confirmed: false })).toThrow();
    expect(() => parseLocalRequest(request(["http://127.0.0.1/private"]))).toThrow();
    expect(() => parseLocalRequest(request(["https://weibo.com.evil.test/1"]))).toThrow();
    expect(() => parseLocalRequest(request(["https://weibo.com:8443/1"]))).toThrow();
    expect(() =>
      parseLocalRequest(request(["https://weibo.com/1", "https://weibo.com/2"])),
    ).toThrow();
    const links = ["https://weibo.com/1", "https://weibo.com/2"];
    const parsed = parseLocalRequest({
      ...request(links),
      linkJudgments: links.map((link, i) => ({ link, judgment: reason + i })),
    });
    expect(parsed.map((item) => item.reason)).toEqual([reason + 0, reason + 1]);
  });

  it("persists outcomes, never calls a backend, and isolates users", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ state: "done", message: "已观察到成功提示", offline: null });
    const result = await submitLocalBatch({
      store,
      userId: "1",
      items: parseLocalRequest(request()),
      config: resolveLocalConfig({}),
      run,
    });
    expect(result.submitted).toBe(false);
    expect(result.accepted).toBe(true);
    await waitForLocalBatch(result.batchId);
    const batch = await store.get("1", result.batchId);
    expect(queryLocalBatch(batch!).summary.submitted).toBe(1);
    expect(await store.get("2", result.batchId)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].sessionDir).toContain("leading-v2-complaint-sessions");
  });

  it("records uncertain execution without retries and stops remaining links", async () => {
    const links = ["https://weibo.com/1", "https://weibo.com/2"];
    const run = vi.fn().mockRejectedValue(new Error("process lost"));
    const result = await submitLocalBatch({
      store,
      userId: "1",
      items: parseLocalRequest({
        ...request(links),
        linkJudgments: links.map((link) => ({ link, judgment: reason })),
      }),
      config: resolveLocalConfig({}),
      run,
    });
    await waitForLocalBatch(result.batchId);
    const status = queryLocalBatch((await store.get("1", result.batchId))!);
    expect(status.summary.unknown).toBe(1);
    expect(status.summary.notSubmitted).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not execute if the initial durable write fails", async () => {
    vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
    const run = vi.fn();
    await expect(
      submitLocalBatch({
        store,
        userId: "1",
        items: parseLocalRequest(request()),
        config: resolveLocalConfig({}),
        run,
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("marks an interrupted running batch unknown, never done", async () => {
    const batch = await store.create("1", request().links);
    batch.executor = "local";
    batch.entries[0].execution = { state: "running", message: "", offline: null };
    expect(queryLocalBatch(batch).summary.unknown).toBe(1);
  });
});
