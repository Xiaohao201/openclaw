import { describe, expect, it, vi } from "vitest";
import { configSchema, sendToWechatGroup } from "./send.js";

const config = {
  endpoint: "http://127.0.0.1:5002/warning_info",
  chatId: "test-business-group",
  groupName: "Example business group",
};

describe("sendToWechatGroup", () => {
  it("posts the exact content to the configured group and confirms errcode zero", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ errcode: 0, errmsg: "ok" }));
    const result = await sendToWechatGroup(
      config,
      { groupName: config.groupName, confirmed: true, content: "  项目通知\n请查收  " },
      fetcher,
    );
    expect(result).toEqual({ status: "sent", groupName: config.groupName });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      config.endpoint,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ chatid: config.chatId, content: "  项目通知\n请查收  " }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    { groupName: config.groupName, confirmed: true, content: " " },
    { groupName: config.groupName, confirmed: true, content: "x", chatid: "other" },
    { groupName: config.groupName, confirmed: true, content: 5 },
    { groupName: config.groupName, confirmed: true, content: "你".repeat(700) },
  ])("rejects invalid content and target overrides without sending: %j", async (args) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(sendToWechatGroup(config, args, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["file:///tmp/test", "http://user:password@localhost/send"])(
    "rejects unsafe endpoint %s",
    async (endpoint) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        sendToWechatGroup(
          { ...config, endpoint },
          { groupName: config.groupName, confirmed: true, content: "hello" },
          fetcher,
        ),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("reports a provider rejection even with HTTP 200", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ errcode: 40070, errmsg: "bad chat" }));
    expect(
      await sendToWechatGroup(
        config,
        { groupName: config.groupName, confirmed: true, content: "hello" },
        fetcher,
      ),
    ).toEqual({
      status: "rejected",
      groupName: config.groupName,
      providerCode: 40070,
    });
  });

  it.each([
    new Response("failure", { status: 500 }),
    new Response("not json"),
    Response.json({ success: true }),
  ])("does not claim delivery for an HTTP error or an unknown response", async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(
      await sendToWechatGroup(
        config,
        { groupName: config.groupName, confirmed: true, content: "hello" },
        fetcher,
      ),
    ).toEqual({
      status: "unknown",
      groupName: config.groupName,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry after network failure because delivery may already have happened", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network failed"));
    expect(
      await sendToWechatGroup(
        config,
        { groupName: config.groupName, confirmed: true, content: "hello" },
        fetcher,
      ),
    ).toEqual({
      status: "unknown",
      groupName: config.groupName,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("honors cancellation before sending", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      sendToWechatGroup(
        config,
        { groupName: config.groupName, confirmed: true, content: "hello" },
        fetcher,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("explicit group selection", () => {
  const multi = {
    endpoint: config.endpoint,
    groups: { Alpha: "test-alpha", Beta: "test-beta", Gamma: "test-gamma" },
  };
  it.each(["Alpha", "Beta", "Gamma"])(
    "routes only to the confirmed %s group",
    async (groupName) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errcode: 0 }));
      expect(
        await sendToWechatGroup(multi, { groupName, confirmed: true, content: "notice" }, fetcher),
      ).toEqual({ status: "sent", groupName });
      expect(fetcher).toHaveBeenCalledWith(
        multi.endpoint,
        expect.objectContaining({
          body: JSON.stringify({
            chatid: multi.groups[groupName as keyof typeof multi.groups],
            content: "notice",
          }),
        }),
      );
    },
  );
  it.each([
    { content: "notice" },
    { content: "notice", confirmed: true },
    { content: "notice", groupName: "Alpha" },
    { content: "notice", groupName: "Alpha", confirmed: false },
    { content: "notice", groupName: "Unknown", confirmed: true },
    { content: "notice", groupName: "Al", confirmed: true },
    { content: "notice", groupName: "Alpha", confirmed: true, chatid: "override" },
  ])("rejects missing confirmation or invalid destination: %j", async (args) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(sendToWechatGroup(multi, args, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not default to the legacy single group", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(sendToWechatGroup(config, { content: "notice" }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { groups: {} },
    { groups: { Alpha: " " } },
    { groups: { Alpha: "test" }, chatId: "legacy", groupName: "Legacy" },
  ])("rejects missing or ambiguous configured groups: %j", (targets) => {
    expect(() => configSchema.parse({ endpoint: config.endpoint, ...targets })).toThrow();
  });
});
