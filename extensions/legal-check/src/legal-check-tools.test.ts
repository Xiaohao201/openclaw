import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { ApiKeyResolver } from "./key-resolver.js";
import { RecentJobStore } from "./recent-jobs.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("./http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const { createLegalCheckCreateToolFactory, createLegalCheckStatusToolFactory } =
  await import("./legal-check-tools.js");

const fakeApi = {
  pluginConfig: { legalApi: { baseUrl: "https://v2.businesstimescn.com" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

// Resolver with an explicit override for 1749 and no db: 1749 resolves to the
// override; any other uid throws (no override, no db to provision from).
const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

const store = new RecentJobStore();
const createFactory = createLegalCheckCreateToolFactory(fakeApi, resolver, store);
const statusFactory = createLegalCheckStatusToolFactory(fakeApi, resolver, store);

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
  it("hides both tools from non-rabbitmq agents", () => {
    expect(createFactory({ agentId: "telegram-1" })).toBeNull();
    expect(statusFactory({ agentId: undefined })).toBeNull();
  });

  it("exposes the tools to rabbitmq-<userId> agents", () => {
    expect(createFactory({ agentId: "rabbitmq-1749" })?.name).toBe("legal_check_create");
    expect(statusFactory({ agentId: "rabbitmq-1749" })?.name).toBe("legal_check_status");
  });
});

describe("legal_check_create", () => {
  const tool = () => createFactory({ agentId: "rabbitmq-1749" })!;

  it("posts /legal/save-job with extracted link + violation defaults, hiding the jobId", async () => {
    mockPostForm.mockResolvedValue({ job: { id: 6378, label: "某文章", status: "Pending" } });
    const res = parse(await tool().execute("c1", { content: "看 https://www.msn.cn/a 这条" }));

    expect(mockPostForm).toHaveBeenCalledTimes(1);
    const [, path, fields, apiKey] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(path).toBe("/legal/save-job");
    expect(apiKey).toBe("sk_test1749");
    expect(fields).toMatchObject({
      requirement: "看 https://www.msn.cn/a 这条",
      link: "https://www.msn.cn/a",
      rumor: 0,
      upload: 0,
      siteId: "legal",
    });
    // The raw id is not handed back to the model — only the user-facing link keeps it.
    expect(res).toMatchObject({
      success: true,
      mode: "violation",
      detailPath: "/business/content/6378",
    });
    expect(res).not.toHaveProperty("jobId");
  });

  it("requires truth + verifiedBy for rumor mode (no backend call)", async () => {
    const res = parse(await tool().execute("c2", { content: "某说法", mode: "rumor" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("sends rumor fields when provided", async () => {
    mockPostForm.mockResolvedValue({ job: { id: 9 } });
    await tool().execute("c3", {
      content: "某说法",
      mode: "rumor",
      truth: "实际情况是X",
      verifiedBy: "市监局",
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({ rumor: 1, data: "实际情况是X", officialUnit: "市监局" });
  });

  it("surfaces a backend danger envelope as an error", async () => {
    mockPostForm.mockResolvedValue({ code: "danger", message: "额度不足" });
    const res = parse(await tool().execute("c4", { content: "https://a.com/x" }));
    expect(res).toMatchObject({ success: false, error: "额度不足" });
  });

  it("errors (no backend call) when no key can be resolved for the account", async () => {
    const noKeyTool = createFactory({ agentId: "rabbitmq-2005" })!;
    const res = parse(await noKeyTool.execute("c5", { content: "https://a.com/x" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });
});

describe("legal_check_create proactive notification", () => {
  const ENQUEUE_SYMBOL = Symbol.for("openclaw.leading-v2.notifyEnqueue");
  const slot = globalThis as unknown as Record<symbol, ((i: unknown) => boolean) | undefined>;

  afterEach(() => {
    slot[ENQUEUE_SYMBOL] = undefined;
  });

  it("registers the job and promises proactive delivery when the hook accepts it", async () => {
    const enqueue = vi.fn((_input: unknown) => true);
    slot[ENQUEUE_SYMBOL] = enqueue as (i: unknown) => boolean;
    mockPostForm.mockResolvedValue({ job: { id: 8100, label: "某文章", status: "Pending" } });

    const tool = createFactory({ agentId: "rabbitmq-1749", sessionId: "session_9" })!;
    const res = parse(await tool.execute("p1", { content: "https://a.com/x" }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      kind: "legal_check",
      uid: "1749",
      backendId: "8100",
      sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_9",
      // No title is sent: the submit-time label is a truncated URL; the poller
      // sources the real title + full link from the backend instead.
      title: null,
    });
    expect(res.agentInstruction).toContain("自动");
    expect(res.agentInstruction).toContain("第一时间");
  });

  it("falls back to poll-only wording when leading-v2's hook is absent", async () => {
    mockPostForm.mockResolvedValue({ job: { id: 8101, status: "Pending" } });
    const tool = createFactory({ agentId: "rabbitmq-1749", sessionId: "session_9" })!;
    const res = parse(await tool.execute("p2", { content: "https://a.com/x" }));
    expect(res.agentInstruction).toContain("不要承诺会主动通知");
  });

  it("does not register a duplicate job for proactive notification", async () => {
    const enqueue = vi.fn((_input: unknown) => true);
    slot[ENQUEUE_SYMBOL] = enqueue as (i: unknown) => boolean;
    mockPostForm.mockResolvedValue({ duplicated: 1, job: { id: 8102, status: "Done" } });

    const tool = createFactory({ agentId: "rabbitmq-1749", sessionId: "session_9" })!;
    const res = parse(await tool.execute("p3", { content: "https://a.com/x" }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(res.agentInstruction).toContain("不要承诺会主动通知");
  });

  it("does not register when no session can be addressed", async () => {
    const enqueue = vi.fn((_input: unknown) => true);
    slot[ENQUEUE_SYMBOL] = enqueue as (i: unknown) => boolean;
    mockPostForm.mockResolvedValue({ job: { id: 8103, status: "Pending" } });

    const tool = createFactory({ agentId: "rabbitmq-1749" })!; // no sessionKey/sessionId
    await tool.execute("p4", { content: "https://a.com/x" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("legal_check_status", () => {
  const tool = () => statusFactory({ agentId: "rabbitmq-1749" })!;

  it("summarizes a completed job without leaking the jobId", async () => {
    mockGetJson.mockResolvedValue({
      job: { id: 6378, status: "Done", label: "某文章", rumor: 0, target: "" },
      detail: { result: "存在违规：虚假宣传", tableData: [{}, {}] },
      letterMap: { Personal: {}, GovPersonal: {} },
    });
    const res = parse(await tool().execute("s1", { jobId: 6378 }));
    expect(res).toMatchObject({
      success: true,
      status: "Done",
      statusLabel: "已完成",
      done: true,
      result: "存在违规：虚假宣传",
      paragraphCount: 2,
      letters: ["Personal", "GovPersonal"],
      detailPath: "/business/content/6378",
    });
    expect(res).not.toHaveProperty("jobId");
  });

  it("polls the most recent job for the account when called with no arguments", async () => {
    const localStore = new RecentJobStore();
    const create = createLegalCheckCreateToolFactory(
      fakeApi,
      resolver,
      localStore,
    )({
      agentId: "rabbitmq-1749",
    })!;
    const status = createLegalCheckStatusToolFactory(
      fakeApi,
      resolver,
      localStore,
    )({
      agentId: "rabbitmq-1749",
    })!;

    mockPostForm.mockResolvedValue({ job: { id: 7001, label: "新文章", status: "Pending" } });
    await create.execute("c1", { content: "https://a.com/x" });

    mockGetJson.mockResolvedValue({ job: { id: 7001, status: "Running", rumor: 0 } });
    const res = parse(await status.execute("s2", {}));

    const [, , query] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(query).toMatchObject({ id: 7001 });
    expect(res).toMatchObject({
      success: true,
      status: "Running",
      detailPath: "/business/content/7001",
    });
  });

  it("errors when there is no recent job and no id is given", async () => {
    const status = createLegalCheckStatusToolFactory(
      fakeApi,
      resolver,
      new RecentJobStore(),
    )({
      agentId: "rabbitmq-1749",
    })!;
    const res = parse(await status.execute("s3", {}));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
