import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("wechat-group-push registration", () => {
  it("registers the default group tool and sends through the configured endpoint", async () => {
    const registerTool = vi.fn();
    plugin.register({
      pluginConfig: {
        endpoint: "http://127.0.0.1:5002/warning_info",
        chatId: "test-group",
        groupName: "Example group",
      },
      registerTool,
    } as unknown as OpenClawPluginApi);
    const tool = registerTool.mock.calls[0][0] as AnyAgentTool;
    expect(tool.name).toBe("wechat_group_push");
    expect(tool.description).toContain("Example group");
    expect(tool.parameters).toMatchObject({ additionalProperties: false, required: ["content"] });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errcode: 0 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await tool.execute("test", { content: "notice" });
    expect(result.details).toEqual({ status: "sent", groupName: "Example group" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:5002/warning_info",
      expect.objectContaining({
        body: JSON.stringify({ chatid: "test-group", content: "notice" }),
      }),
    );
    fetcher.mockResolvedValueOnce(Response.json({ errcode: 40070 }));
    expect(await tool.execute("failure", { content: "notice" })).toMatchObject({
      isError: true,
      details: { status: "rejected" },
    });
  });

  it("does not register a send tool without an explicit destination", () => {
    const registerTool = vi.fn();
    expect(() =>
      plugin.register({ pluginConfig: {}, registerTool } as unknown as OpenClawPluginApi),
    ).toThrow();
    expect(registerTool).not.toHaveBeenCalled();
  });
});
