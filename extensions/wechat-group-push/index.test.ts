import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { readCurrentConfig } from "./src/config.runtime.js";

vi.mock("./src/config.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/config.runtime.js")>()),
  readCurrentConfig: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(groups: Record<string, string> = { Alpha: "a" }) {
  const config = { endpoint: "http://127.0.0.1/send", groups };
  let current: unknown = config;
  const registerTool = vi.fn();
  const registerReload = vi.fn();
  const loadConfig = () => ({ plugins: { entries: { "wechat-group-push": { config: current } } } });
  vi.mocked(readCurrentConfig).mockImplementation(async () => current);
  plugin.register({
    pluginConfig: config,
    registerTool,
    registerReload,
    runtime: { config: { loadConfig } },
  } as unknown as OpenClawPluginApi);
  const create = () =>
    (registerTool.mock.calls[0][0] as OpenClawPluginToolFactory)({}) as AnyAgentTool;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errcode: 0 }));
  vi.stubGlobal("fetch", fetcher);
  return {
    create,
    registerReload,
    fetcher,
    set: (value: unknown) => {
      current = value;
    },
    update: (next: Record<string, string>) => {
      current = { ...config, groups: next };
    },
  };
}
function args(tool: AnyAgentTool, groupName = "Alpha") {
  const schema = tool.parameters as unknown as {
    properties: { destinationVersion: { description: string } };
  };
  const versions = JSON.parse(schema.properties.destinationVersion.description.split("\n").at(-1)!);
  return { groupName, confirmed: true, content: "notice", destinationVersion: versions[groupName] };
}
describe("dynamic group configuration", () => {
  it("declares only groups as dynamically read and sends to a newly added group", async () => {
    const h = setup();
    const before = h.create();
    h.update({ Alpha: "a", Beta: "b" });
    const after = h.create();
    expect(before.description).not.toContain("Beta");
    expect(after.description).toContain("Beta");
    expect(h.registerReload).toHaveBeenCalledWith({
      noopPrefixes: ["plugins.entries.wechat-group-push.config.groups"],
    });
    expect(await after.execute("test", args(after, "Beta"))).toMatchObject({
      details: { status: "sent", groupName: "Beta" },
    });
    expect(h.fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1/send",
      expect.objectContaining({ body: JSON.stringify({ chatid: "b", content: "notice" }) }),
    );
  });
  it("rejects a deleted group even for an existing tool", async () => {
    const h = setup();
    const tool = h.create();
    const input = args(tool);
    h.update({ Beta: "b" });
    await expect(tool.execute("test", input)).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("rejects an old confirmation across tool recreation after a destination change", async () => {
    const h = setup();
    const input = args(h.create());
    h.update({ Alpha: "changed" });
    const tool = h.create();
    await expect(tool.execute("test", input)).rejects.toThrow(/confirm/i);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(await tool.execute("new", args(tool))).toMatchObject({ details: { status: "sent" } });
  });
  it("rejects invalid disk config instead of using the tool snapshot", async () => {
    const h = setup();
    const tool = h.create();
    h.set({});
    await expect(tool.execute("test", args(tool))).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("propagates config read failures without sending", async () => {
    const h = setup();
    const tool = h.create();
    vi.mocked(readCurrentConfig).mockRejectedValue(new Error("Invalid config"));
    await expect(tool.execute("test", args(tool))).rejects.toThrow("Invalid config");
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("keeps payloads and confirmation versions stable when only insertion order changes", () => {
    const h = setup({ Beta: "b", Alpha: "a" });
    const payload = (tool: AnyAgentTool) =>
      JSON.stringify({ description: tool.description, parameters: tool.parameters });
    const before = payload(h.create());
    h.update({ Alpha: "a", Beta: "b" });
    expect(payload(h.create())).toBe(before);
  });
  it("rejects missing confirmation and version without sending", async () => {
    const h = setup();
    const tool = h.create();
    await expect(tool.execute("test", { ...args(tool), confirmed: false })).rejects.toThrow();
    await expect(
      tool.execute("test", { ...args(tool), destinationVersion: undefined }),
    ).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("preserves legacy single-group configuration", async () => {
    const h = setup();
    h.set({ endpoint: "http://127.0.0.1/send", groupName: "Alpha", chatId: "a" });
    const tool = h.create();
    expect(await tool.execute("test", args(tool))).toMatchObject({ details: { status: "sent" } });
  });
  it("reports provider rejection", async () => {
    const h = setup();
    const tool = h.create();
    h.fetcher.mockResolvedValueOnce(Response.json({ errcode: 40070 }));
    expect(await tool.execute("test", args(tool))).toMatchObject({
      isError: true,
      details: { status: "rejected" },
    });
  });
});
