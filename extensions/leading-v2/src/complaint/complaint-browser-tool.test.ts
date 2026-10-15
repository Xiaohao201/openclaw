import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import {
  createComplaintBrowserToolFactory,
  stopComplaintBrowserSessions,
} from "./complaint-browser-tool.js";
import { resolveLocalConfig } from "./complaint-local-contract.js";

let root: string;
let api: OpenClawPluginApi;
const details = (r: unknown) => (r as { details: Record<string, unknown> }).details;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "complaint-browser-"));
  await writeFile(
    join(root, "browser_setup.py"),
    [
      "import json,sys,os",
      "data=json.loads(sys.stdin.readline())",
      "assert os.environ['OPENCLAW_COMPLAINT_ALLOW_FAKE_IP']=='1'",
      "print(json.dumps(dict(state='awaiting_login',message='fixture')),flush=True)",
      "for line in sys.stdin:",
      " action=json.loads(line)['action']",
      " if action in ('finish','cancel'):",
      "  print(json.dumps(dict(state='saved' if action=='finish' else 'cancelled',message='fixture')),flush=True)",
      "  break",
    ].join("\n"),
  );
  api = {
    config: { browser: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } },
    pluginConfig: { complaintExecution: { runtimeDir: root } },
    runtime: { state: { resolveStateDir: () => root } },
  } as unknown as OpenClawPluginApi;
});
afterEach(async () => {
  await stopComplaintBrowserSessions();
  await rm(root, { recursive: true, force: true });
});

describe("user-scoped complaint browser", () => {
  it("inherits only the narrow explicit host flag", () => {
    expect(
      resolveLocalConfig({}, undefined, {
        browser: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } },
      }).allowFakeIp,
    ).toBe(true);
    expect(
      resolveLocalConfig({}, undefined, {
        browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
      }).allowFakeIp,
    ).toBe(false);
    expect(resolveLocalConfig({}).allowFakeIp).toBe(false);
    expect(() => resolveLocalConfig({ complaintExecution: { allowFakeIp: true } })).toThrow();
  });
  it("requires authorization and rejects cross-user and unsupported parameters", async () => {
    const factory = createComplaintBrowserToolFactory(api);
    expect(factory({ agentId: "untrusted" })).toBeNull();
    const tool = factory({ agentId: "rabbitmq-1" })!;
    for (const params of [
      { action: "login", platform: "weibo" },
      { action: "login", platform: "wechat", confirmed: true },
      { action: "login", platform: "weibo", confirmed: true, userId: "2" },
      { action: "login", platform: "weibo", confirmed: true, profileDir: root },
    ]) {
      expect(details(await tool.execute("x", params)).success).toBe(false);
    }
  });
  it("keeps live login sessions isolated and saves only after explicit confirmation", async () => {
    const factory = createComplaintBrowserToolFactory(api);
    const first = factory({ agentId: "rabbitmq-1" })!;
    const second = factory({ agentId: "rabbitmq-2" })!;
    expect(
      details(await first.execute("login", { action: "login", platform: "weibo", confirmed: true }))
        .state,
    ).toBe("awaiting_login");
    expect(details(await second.execute("status", { action: "status" })).session).toBeNull();
    expect(
      details(await second.execute("finish", { action: "finish", confirmed: true })).success,
    ).toBe(false);
    expect(
      details(await first.execute("again", { action: "login", platform: "weibo", confirmed: true }))
        .state,
    ).toBe("busy");
    expect(details(await first.execute("finish", { action: "finish" })).success).toBe(false);
    expect(
      details(await first.execute("finish", { action: "finish", confirmed: true })).state,
    ).toBe("saved");
  });
});
