import { describe, expect, it, vi } from "vitest";
import { sendToWechatGroup } from "./send.js";

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
    const result = await sendToWechatGroup(config, { content: "  项目通知\n请查收  " }, fetcher);
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
    { content: " " },
    { content: "x", chatid: "other" },
    { content: 5 },
    { content: "你".repeat(700) },
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
        sendToWechatGroup({ ...config, endpoint }, { content: "hello" }, fetcher),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("reports a provider rejection even with HTTP 200", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ errcode: 40070, errmsg: "bad chat" }));
    expect(await sendToWechatGroup(config, { content: "hello" }, fetcher)).toEqual({
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
    expect(await sendToWechatGroup(config, { content: "hello" }, fetcher)).toEqual({
      status: "unknown",
      groupName: config.groupName,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry after network failure because delivery may already have happened", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network failed"));
    expect(await sendToWechatGroup(config, { content: "hello" }, fetcher)).toEqual({
      status: "unknown",
      groupName: config.groupName,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("honors cancellation before sending", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      sendToWechatGroup(config, { content: "hello" }, fetcher, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
