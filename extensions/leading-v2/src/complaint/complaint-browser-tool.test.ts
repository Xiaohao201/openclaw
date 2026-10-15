import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "../../api.js";
import {
  createComplaintBrowserToolFactory,
  stopComplaintBrowserSessions,
} from "./complaint-browser-tool.js";
import { resolveLocalConfig } from "./complaint-local-contract.js";
import { sessionBrowserHandoffs } from "./complaint-session-handoff.js";

let root: string;
let api: OpenClawPluginApi;
const details = (r: unknown) => (r as { details: Record<string, unknown> }).details;
const firstContext = {
  agentId: "rabbitmq-1",
  sessionKey: "agent:rabbitmq-1:chat:first",
  sessionId: "first",
};
const marker = "12345678-1234-1234-1234-123456789abc";
async function observePage(action: "open" | "snapshot" = "open") {
  const registry = sessionBrowserHandoffs(api);
  const params = await registry.before(firstContext, { action, targetId: "7" });
  await registry.observe(firstContext, params, {
    details: { targetId: "7", sessionHandoff: { version: 1, marker } },
  });
  return registry;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "complaint-browser-"));
  await writeFile(
    join(root, "browser_setup.py"),
    [
      "import json,sys,os",
      "data=json.loads(sys.stdin.readline())",
      "assert os.environ['OPENCLAW_COMPLAINT_ALLOW_FAKE_IP']=='1'",
      "handoff=data['browserHandoff']",
      "assert handoff['targetId']=='7'",
      `assert handoff['marker']=='${marker}'`,
      "with open(os.path.join(data['sessionDir'],'browser-binding.json'),encoding='utf-8') as file:",
      " assert handoff['binding']==json.load(file)",
      "print(json.dumps(dict(state='awaiting_login',message='fixture')),flush=True)",
      "for line in sys.stdin:",
      " action=json.loads(line)['action']",
      " if action in ('finish','cancel'):",
      "  print(json.dumps(dict(state='saved' if action=='finish' else 'cancelled',message='fixture')),flush=True)",
      "  break",
    ].join("\n"),
  );
  let config: OpenClawConfig = {
    browser: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } },
  };
  api = {
    config,
    pluginConfig: { complaintExecution: { runtimeDir: root } },
    runtime: {
      state: { resolveStateDir: () => root },
      config: {
        loadConfig: () => config,
        writeConfigFile: async (next: OpenClawConfig) => {
          config = next;
        },
      },
    },
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
    await observePage();
    const first = factory(firstContext)!;
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

  it("requires a page observed by the current OpenClaw conversation before starting login", async () => {
    const tool = createComplaintBrowserToolFactory(api)(firstContext)!;
    expect(
      details(
        await tool.execute("login", {
          action: "login",
          platform: "weibo",
          confirmed: true,
        }),
      ),
    ).toMatchObject({ success: false, errorCode: "BROWSER_HANDOFF_REQUIRED" });
    expect(details(await tool.execute("status", { action: "status" })).session).toBeNull();
  });

  it("leases the same browser and returns its tab for a fresh browser snapshot after login", async () => {
    const registry = await observePage();
    const tool = createComplaintBrowserToolFactory(api)(firstContext)!;
    expect(
      details(
        await tool.execute("login", {
          action: "login",
          platform: "weibo",
          confirmed: true,
        }),
      ),
    ).toMatchObject({ state: "awaiting_login", browserTargetId: "7" });
    await expect(registry.before(firstContext, { action: "status" })).rejects.toThrow("完成前");
    expect(
      details(await tool.execute("finish", { action: "finish", confirmed: true })),
    ).toMatchObject({ state: "saved", browserTargetId: "7" });
    await expect(
      registry.before(firstContext, { action: "snapshot", targetId: "7" }),
    ).resolves.toMatchObject({ targetId: "7" });
    await observePage("snapshot");
    const lease = await registry.acquire(firstContext);
    expect(lease.handoff.targetId).toBe("7");
    lease.release();
  });

  it("does not let another conversation view or finish the borrowed login tab", async () => {
    await observePage();
    const factory = createComplaintBrowserToolFactory(api);
    const first = factory(firstContext)!;
    const other = factory({
      ...firstContext,
      sessionKey: "agent:rabbitmq-1:chat:other",
      sessionId: "other",
    })!;
    await first.execute("login", { action: "login", platform: "weibo", confirmed: true });
    expect(details(await other.execute("status", { action: "status" })).session).toBeNull();
    for (const action of ["screenshot", "finish", "cancel"]) {
      expect(details(await other.execute(action, { action, confirmed: true })).success).toBe(false);
    }
    expect(details(await first.execute("status", { action: "status" })).session).toMatchObject({
      active: true,
    });
  });

  it("releases the OpenClaw browser after cancellation, worker failure, and shutdown", async () => {
    for (const action of ["cancel", "shutdown", "failure"]) {
      const registry = await observePage();
      const tool = createComplaintBrowserToolFactory(api)(firstContext)!;
      if (action === "failure") {
        await writeFile(join(root, "browser_setup.py"), "import sys\nsys.exit(1)\n");
      }
      const result = details(
        await tool.execute("login", { action: "login", platform: "weibo", confirmed: true }),
      );
      if (action === "cancel") {
        expect(details(await tool.execute("cancel", { action: "cancel" })).state).toBe("cancelled");
      } else if (action === "failure") {
        expect(result.state).toBe("failed");
      } else {
        await stopComplaintBrowserSessions();
      }
      await expect(registry.before(firstContext, { action: "status" })).resolves.toMatchObject({
        target: "host",
      });
    }
  });

  it("releases the browser when the Python executable cannot start", async () => {
    const registry = await observePage();
    api.pluginConfig = {
      complaintExecution: { runtimeDir: root, python: join(root, "missing-python") },
    };
    const tool = createComplaintBrowserToolFactory(api)(firstContext)!;
    expect(
      details(await tool.execute("login", { action: "login", platform: "weibo", confirmed: true })),
    ).toMatchObject({ state: "failed", browserTargetId: "7" });
    await expect(registry.before(firstContext, { action: "status" })).resolves.toMatchObject({
      target: "host",
    });
  });
});
