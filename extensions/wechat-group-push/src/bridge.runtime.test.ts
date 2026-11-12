import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn(), connect: vi.fn() }));
vi.mock("./group-store.runtime.js", () => ({
  groupAdmin: { read: deps.read, mutate: deps.mutate },
}));
vi.mock("amqplib", () => ({ default: { connect: deps.connect } }));
import { startGroupBridge } from "./bridge.runtime.js";

let folder: string;
let stop: (() => Promise<void>) | undefined;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "group-bridge-test-"));
  vi.stubEnv("WECHAT_GROUP_BRIDGE_URL", "https://example.com");
  vi.stubEnv("WECHAT_GROUP_BRIDGE_NODE_ID", "test-node");
  vi.stubEnv("WECHAT_GROUP_BRIDGE_TOKEN", "test-only-token-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("WECHAT_GROUP_BRIDGE_AMQP_URL", "");
  deps.read.mockReset().mockResolvedValue({ groups: { Alpha: "a" }, version: "v1" });
  deps.mutate
    .mockReset()
    .mockResolvedValue({ groups: { Alpha: "a", Beta: "b" }, version: "v2", status: "saved" });
  deps.connect.mockReset();
  vi.clearAllMocks();
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});
function context() {
  return { stateDir: folder, config: {}, logger } as OpenClawPluginServiceContext;
}
const job = {
  id: "a".repeat(32),
  lease: "b".repeat(32),
  input: { action: "add", name: "Beta", chatId: "b", version: "v1" },
};
async function journalPath() {
  const base = path.join(folder, "wechat-group-bridge");
  return path.join(base, (await readdir(base))[0], "pending.json");
}

describe("bridge runtime", () => {
  it("does nothing when the bridge is disabled", async () => {
    vi.stubEnv("WECHAT_GROUP_BRIDGE_URL", "");
    stop = await startGroupBridge(context());
    expect(deps.read).not.toHaveBeenCalled();
  });
  it.each([
    ["WECHAT_GROUP_BRIDGE_URL", "http://remote.example.com"],
    ["WECHAT_GROUP_BRIDGE_URL", "https://user:password@example.com"],
    ["WECHAT_GROUP_BRIDGE_NODE_ID", "../node"],
    ["WECHAT_GROUP_BRIDGE_TOKEN", "short"],
  ])("rejects invalid %s", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(startGroupBridge(context())).rejects.toThrow();
  });
  it("uses outbound authenticated fixed endpoints and clears the durable report after acceptance", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      expect(options?.redirect).toBe("error");
      expect(JSON.parse(String(options?.body)).nodeId).toBe("test-node");
      if (String(url).endsWith("/claim")) {
        return Response.json({ job });
      }
      expect(String(url)).toBe("https://example.com/wechat-group-node/complete");
      expect(JSON.parse(String(options?.body)).result.ok).toBe(true);
      return Response.json({ accepted: true });
    });
    vi.stubGlobal("fetch", fetcher);
    stop = await startGroupBridge(context());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await stop();
    expect(JSON.parse(await readFile(await journalPath(), "utf8"))).toBeNull();
  });
  it("retains a completed result across restart when HTTP reporting fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ job }))
      .mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    stop = await startGroupBridge(context());
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    await stop();
    const file = await journalPath();
    expect(JSON.parse(await readFile(file, "utf8")).result.ok).toBe(true);
    fetcher.mockResolvedValue(Response.json({ accepted: true }));
    stop = await startGroupBridge(context());
    await vi.waitFor(async () => expect(JSON.parse(await readFile(file, "utf8"))).toBeNull());
    expect(deps.mutate).toHaveBeenCalledOnce();
  });
  it("does not claim new jobs when the journal is corrupt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ job: null })));
    stop = await startGroupBridge(context());
    await vi.waitFor(() => expect(deps.read).toHaveBeenCalledOnce());
    await stop();
    await writeFile(await journalPath(), "corrupt");
    deps.read.mockClear();
    stop = await startGroupBridge(context());
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    expect(deps.read).not.toHaveBeenCalled();
  });
  it("binds a dedicated wakeup queue and falls back to HTTP when MQ fails", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    vi.stubEnv("WECHAT_GROUP_BRIDGE_AMQP_URL", "amqp://example.com");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ job: null })));
    const channel = {
      on: vi.fn(),
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
      bindQueue: vi.fn(),
      consume: vi.fn(),
      ack: vi.fn(),
    };
    const connection = {
      on: vi.fn(),
      createChannel: async () => channel,
      close: vi.fn().mockResolvedValue(undefined),
    };
    deps.connect.mockResolvedValue(connection);
    stop = await startGroupBridge(context());
    await vi.waitFor(() => expect(channel.consume).toHaveBeenCalled());
    expect(channel.bindQueue).toHaveBeenCalledWith(
      "wechat-group-admin.wakeup.v1.test-node",
      "wechat-group-admin.wakeup.v1",
      "",
    );
    const receive = channel.consume.mock.calls[0][1];
    receive(null);
    receive({ content: Buffer.from("ignored, never executed") });
    expect(channel.ack).toHaveBeenCalledOnce();
    const connEvent = (name: string) =>
      connection.on.mock.calls.find(([event]) => event === name)![1];
    const channelEvent = (name: string) =>
      channel.on.mock.calls.find(([event]) => event === name)![1];
    connEvent("error")(new Error("redacted"));
    channelEvent("error")(new Error("redacted"));
    connection.close.mockRejectedValueOnce(new Error("already closed"));
    channelEvent("close")();
    connEvent("close")();
    const interval = intervals.mock.calls[0][0] as () => void;
    interval();
    await vi.waitFor(() => expect(deps.connect).toHaveBeenCalledTimes(2));
    await stop();
    deps.connect.mockRejectedValue(new Error("secret broker URL"));
    stop = await startGroupBridge(context());
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("MQ unavailable")),
    );
    expect(deps.mutate).not.toHaveBeenCalled();
  });
  it("keeps its report if the server returns JSON without an acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ job }))
        .mockResolvedValue(Response.json({ login: 1 })),
    );
    stop = await startGroupBridge(context());
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    await stop();
    expect(JSON.parse(await readFile(await journalPath(), "utf8")).result.ok).toBe(true);
  });
});
