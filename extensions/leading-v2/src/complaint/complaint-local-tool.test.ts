import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { createComplaintSubmitToolFactory } from "../ai/ai-tools.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { waitForLocalBatch } from "./complaint-local.js";
import { createComplaintTaskStatusToolFactory } from "./complaint-status-tool.js";
import { createComplaintTaxonomyToolFactory } from "./complaint-taxonomy-tool.js";

let root: string;
let api: OpenClawPluginApi;
const parse = (value: unknown) => (value as { details: Record<string, unknown> }).details;
const resolver = new ApiKeyResolver({}, undefined);
// Transport fixture: session ownership and stale-tab behavior are exercised in
// complaint-session-handoff.test.ts; this suite checks batch/process plumbing.
vi.mock("./complaint-session-handoff.js", () => ({
  sessionBrowserHandoffs: () => ({ acquire: async () => ({
    handoff: { version: 1, targetId: "fixture", marker: "12345678-1234-1234-1234-123456789abc", binding: {} },
    release() {},
  }) }),
}));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "complaint-tool-"));
  // Real child-process protocol with a deterministic test executor, no network/browser.
  await writeFile(
    join(root, "runner.py"),
    [
      "import json, sys",
      "data = json.load(sys.stdin)",
      "assert data['platform'] == 'weibo'",
      "assert data['reason'].endswith('测试。')",
      "print(json.dumps(dict(state='done', message='confirmed fixture', offline=None)))",
    ].join("\n"),
  );
  api = {
    pluginConfig: { complaintExecution: { runtimeDir: root } },
    runtime: { state: { resolveStateDir: () => root } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as OpenClawPluginApi;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Backend access forbidden")));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("local tool integration", () => {
  it("rejects a missing runtime before accepting or persisting a batch", async () => {
    await rm(join(root, "runner.py"));
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
      success: false,
      accepted: false,
      submitted: false,
      errorCode: "RUNTIME_MISSING",
    });
    expect(result.batchId).toBeUndefined();
    const status = createComplaintTaskStatusToolFactory(api, resolver)({ agentId: "rabbitmq-1" })!;
    expect(parse(await status.execute("list", {})).total).toBe(0);
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
    expect(result.submitted).toBe(false);
    await waitForLocalBatch(result.batchId as string);
    const status = createComplaintTaskStatusToolFactory(api, resolver);
    const owned = parse(
      await status({ agentId: "rabbitmq-1" })!.execute("status", { batchId: result.batchId }),
    );
    expect(owned.summary).toMatchObject({ submitted: 1, unknown: 0 });
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
    expect(result.platforms).toEqual(expect.arrayContaining(["tencent", "report12377"]));
    expect(result.links).toEqual(links.map((link) => ({ link, platform: null })));
  });
});
