import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { ComplaintBatchStore } from "./complaint-batch-store.js";
import { submitComplaintBatch } from "./complaint-batch-submit.js";

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("../client/http-client.js", () => ({
  postForm: post,
  getJson: get,
  resolveConfig: () => ({ baseUrl: "https://example.test", timeoutMs: 30000, siteId: "legal" }),
  BackendApiError: class extends Error {},
}));
const { createComplaintSubmitToolFactory } = await import("../ai/ai-tools.js");
const { createComplaintTaskStatusToolFactory } = await import("./complaint-status-tool.js");

let root: string;
let api: OpenClawPluginApi;
const resolver = new ApiKeyResolver({ "1": "test-user-1", "2": "test-user-2" }, undefined);
const parse = (value: unknown) => (value as { details: Record<string, unknown> }).details;
const submit = (uid = "1") =>
  createComplaintSubmitToolFactory(api, resolver)({ agentId: `rabbitmq-${uid}` })!;
const status = (uid = "1") =>
  createComplaintTaskStatusToolFactory(api, resolver)({ agentId: `rabbitmq-${uid}` })!;
function params(count: number) {
  const links = Array.from({ length: count }, (_, i) => `https://weibo.com/1/${i}`);
  const judgment = "已核对原始内容及用户证据，存在具体虚构事实，依据对应规则提出举报。";
  return {
    basisSource: "AgentJudgment",
    confirmed: true,
    subjectScope: "Institution",
    judgment,
    links,
    linkJudgments: links.map((link) => ({ link, judgment })),
    classifications: links.map((link) => ({
      link,
      taxonomyVersionId: 1,
      categoryCode: "false_information",
    })),
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "complaint-batch-"));
  api = {
    pluginConfig: {},
    runtime: { state: { resolveStateDir: () => root } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as OpenClawPluginApi;
  post.mockReset();
  get.mockReset();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("persistent complaint batches", () => {
  it("keeps repeated URLs in separate batches for the same user", async () => {
    post
      .mockResolvedValueOnce({ code: "success", taskId: 7 })
      .mockResolvedValueOnce({ code: "success", taskId: 8 });
    const first = parse(await submit().execute("first", params(1)));
    const second = parse(await submit().execute("second", params(1)));
    expect(first.batchId).not.toBe(second.batchId);
    expect(first.taskRefs).toEqual([expect.objectContaining({ taskId: 7 })]);
    expect(second.taskRefs).toEqual([expect.objectContaining({ taskId: 8 })]);
    expect(
      parse(await status().execute("page", { listBatches: true, size: 1, page: 2 })),
    ).toMatchObject({ total: 2, batches: [expect.anything()] });
  });

  it("preserves a legacy multi-link task and queries it only once", async () => {
    const links = params(2).links;
    get.mockResolvedValueOnce({ jobs: [{ id: 9, link: links[0] }] });
    post.mockResolvedValue({ code: "success", taskId: 44 });
    const created = parse(await submit().execute("legacy", { links }));
    expect(created.taskRefs).toEqual(
      links.map((link) => expect.objectContaining({ link, taskId: 44 })),
    );
    get.mockClear();
    get.mockResolvedValue({
      code: "success",
      list: links.map((link, i) => ({ taskId: 44, link, status: i ? "Fail" : "Done" })),
    });
    expect(parse(await status().execute("query", { batchId: created.batchId }))).toMatchObject({
      summary: { total: 2, submitted: 1, failed: 1 },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retains task IDs when backend queue publication needs recovery", async () => {
    post.mockResolvedValue({
      code: "error",
      submitted: false,
      taskId: 91,
      recoveryRequired: true,
      errorCode: "SUBMISSION_UNKNOWN",
    });
    const created = parse(await submit().execute("queue-error", params(2)));
    expect(created).toMatchObject({
      success: false,
      unknownLinks: [params(2).links[0]],
      pendingLinks: [params(2).links[1]],
    });
    expect(created.taskRefs).toEqual([
      expect.objectContaining({ taskId: 91, acceptance: "unknown" }),
      expect.objectContaining({ taskId: null }),
    ]);
    get.mockResolvedValue({
      code: "success",
      list: [{ taskId: 91, link: params(2).links[0], status: "Stop" }],
    });
    expect(parse(await status().execute("query", { batchId: created.batchId }))).toMatchObject({
      summary: { stopped: 1, notSubmitted: 1 },
    });
  });

  it("rejects duplicate links before posting", async () => {
    const input = params(1);
    input.links.push(input.links[0]);
    expect(parse(await submit().execute("duplicate", input))).toMatchObject({ success: false });
    expect(post).not.toHaveBeenCalled();
  });
  it("tracks all 100 links by exact task ID across tool instances and user interleaving", async () => {
    let id = 1000;
    const records = new Map<number, { link: string; key: string }>();
    post.mockImplementation(async (_config, _path, fields, key) => {
      const taskId = ++id;
      records.set(taskId, { link: JSON.parse(fields.links)[0], key });
      return { code: "success", submitted: true, taskId };
    });
    const [first, other] = await Promise.all([
      submit().execute("a", params(100)).then(parse),
      submit("2").execute("b", params(3)).then(parse),
    ]);
    expect(first.batchId).toEqual(expect.any(String));
    expect(first.taskRefs).toHaveLength(100);
    expect(first.batchId).not.toBe(other.batchId);
    get.mockImplementation(async (_config, path, _params, key) => {
      const taskId = Number(path.split("/").at(-1));
      const record = records.get(taskId)!;
      expect(key).toBe(record.key);
      return {
        code: "success",
        list: [{ id: taskId, taskId, link: record.link, submissionStatus: "Done", offline: 0 }],
      };
    });
    const result = parse(await status().execute("query", { batchId: first.batchId }));
    expect(result).toMatchObject({
      success: true,
      mode: "batch",
      summary: { total: 100, submitted: 100, unknown: 0, offline: 0 },
    });
    expect(result.links).toHaveLength(100);
    expect(get).toHaveBeenCalledTimes(100);
    expect(get.mock.calls.every((call) => call[1].startsWith("/legal/fetch-complaints/"))).toBe(
      true,
    );
    get.mockClear();
    expect(parse(await status("2").execute("forbidden", { batchId: first.batchId }))).toMatchObject(
      { success: false },
    );
    expect(get).not.toHaveBeenCalled();
    const listed = parse(await status().execute("list", { listBatches: true }));
    expect(listed.batches).toEqual([
      expect.objectContaining({ batchId: first.batchId, total: 100 }),
    ]);
  });

  it("keeps accepted, uncertain, and unattempted links after a transport failure", async () => {
    post
      .mockResolvedValueOnce({ code: "success", taskId: 51 })
      .mockRejectedValueOnce(new Error("network"));
    const created = parse(await submit().execute("partial", params(3)));
    expect(created).toMatchObject({ success: false, batchId: expect.any(String) });
    expect(post).toHaveBeenCalledTimes(2);
    get.mockResolvedValue({
      code: "success",
      list: [{ id: 1, taskId: 51, link: params(3).links[0], status: "Pending" }],
    });
    const result = parse(await status().execute("query", { batchId: created.batchId }));
    expect(result).toMatchObject({
      summary: { total: 3, processing: 1, unknown: 1, notSubmitted: 1 },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not invent task IDs when an older backend omits them", async () => {
    post.mockResolvedValue({ code: "success" });
    const created = parse(await submit().execute("legacy", params(1)));
    const result = parse(await status().execute("query", { batchId: created.batchId }));
    expect(result).toMatchObject({ summary: { total: 1, unknown: 1, submitted: 0 } });
    expect(get).not.toHaveBeenCalled();
  });

  it("counts missing, mismatched, and failed queries as unknown while keeping good results", async () => {
    let id = 0;
    post.mockImplementation(async () => ({ code: "success", taskId: ++id }));
    const created = parse(await submit().execute("mixed", params(4)));
    get.mockImplementation(async (_c, path) => {
      const taskId = Number(path.split("/").at(-1));
      if (taskId === 1) {
        throw new Error("offline");
      }
      if (taskId === 2) {
        return { code: "success", list: [] };
      }
      if (taskId === 3) {
        return {
          code: "success",
          list: [{ taskId: 999, link: params(4).links[2], status: "Done" }],
        };
      }
      return {
        code: "success",
        list: [{ taskId: 4, link: params(4).links[3], status: "Stop", memo: "拒绝", offline: 1 }],
      };
    });
    const result = parse(await status().execute("query", { batchId: created.batchId }));
    expect(result).toMatchObject({
      summary: { total: 4, unknown: 3, stopped: 1, offline: 1, submitted: 0 },
    });
  });

  it("rejects path traversal and ambiguous query modes before backend access", async () => {
    for (const args of [{ batchId: "../other" }, { batchId: "bad", taskId: 1 }]) {
      expect(parse(await status().execute("invalid", args))).toMatchObject({ success: false });
    }
    expect(get).not.toHaveBeenCalled();
  });
});

describe("batch checkpoints", () => {
  const run = (store: ComplaintBatchStore) =>
    submitComplaintBatch({
      store,
      userId: "1",
      config: { baseUrl: "https://example.test", timeoutMs: 30000, siteId: "legal", apiKeys: {} },
      apiKey: "test-user-1",
      links: params(2).links,
      requests: params(2).links.map((link) => ({
        links: [link],
        fields: { links: JSON.stringify([link]) },
      })),
    });

  it("does not post if initial storage fails", async () => {
    const store = new ComplaintBatchStore(() => root);
    vi.spyOn(store, "create").mockRejectedValue(new Error("disk"));
    expect(await run(store)).toMatchObject({ success: false, submitted: false });
    expect(post).not.toHaveBeenCalled();
  });

  it("stops before posting when a pre-request checkpoint fails", async () => {
    const store = new ComplaintBatchStore(() => root);
    const save = store.save.bind(store);
    let count = 0;
    vi.spyOn(store, "save").mockImplementation((batch) =>
      ++count === 2 ? Promise.reject(new Error("disk")) : save(batch),
    );
    const result = await run(store);
    expect(result).toMatchObject({ success: false, pendingLinks: params(2).links });
    expect(post).not.toHaveBeenCalled();
  });

  it("leaves an uncertain durable checkpoint if saving an accepted response fails", async () => {
    const store = new ComplaintBatchStore(() => root);
    const save = store.save.bind(store);
    let count = 0;
    vi.spyOn(store, "save").mockImplementation((batch) =>
      ++count === 3 ? Promise.reject(new Error("disk")) : save(batch),
    );
    post.mockResolvedValue({ code: "success", taskId: 22 });
    const result = await run(store);
    expect(result).toMatchObject({
      success: false,
      taskRefs: [
        expect.objectContaining({ taskId: 22 }),
        expect.objectContaining({ taskId: null }),
      ],
    });
    expect(post).toHaveBeenCalledTimes(1);
    const batches = await new ComplaintBatchStore(() => root).list("1");
    expect(batches[0].entries[0]).toMatchObject({ acceptance: "inflight", taskId: null });
    expect(await store.list("2")).toEqual([]);
  });
});
