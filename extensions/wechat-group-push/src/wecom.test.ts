import { describe, expect, it, vi } from "vitest";
import type { CreateGroupInput } from "./admin.js";
import { createWecomClient } from "./wecom.js";

const input: CreateGroupInput = {
  action: "create",
  version: "v1",
  name: "Example",
  owner: "one",
  userlist: ["one", "two"],
  requestId: "0123456789abcdef0123456789abcdef",
};
describe("WeCom group creation", () => {
  it("caches tokens and uses the requested group ID without logging credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "example-token", expires_in: 7200 }))
      .mockImplementation(async () => Response.json({ errcode: 0, chatid: input.requestId }));
    const create = createWecomClient(
      () => ({ corpId: "example-corp", secret: "example-secret" }),
      fetcher,
    );
    expect(await create(input)).toBe(input.requestId);
    expect(await create(input)).toBe(input.requestId);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      name: "Example",
      owner: "one",
      userlist: ["one", "two"],
      chatid: input.requestId,
    });
  });
  it("fails closed when credentials or the token response are invalid", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errcode: 40013 }));
    await expect(
      createWecomClient(() => ({ corpId: undefined, secret: undefined }), fetcher)(input),
    ).rejects.toMatchObject({ code: "WECOM_NOT_CONFIGURED" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      createWecomClient(() => ({ corpId: "corp", secret: "secret" }), fetcher)(input),
    ).rejects.toMatchObject({ code: "TOKEN_FAILED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [() => Promise.reject(new Error("access_token=must-not-leak")), "CREATE_UNKNOWN"],
    [() => Promise.resolve(Response.json({ errcode: 40013 })), "WECOM_REJECTED"],
    [() => Promise.resolve(Response.json({ errcode: 0 })), "CREATE_UNKNOWN"],
    [() => Promise.resolve(new Response("failure", { status: 503 })), "CREATE_UNKNOWN"],
  ] as const)("preserves recovery ID for failed or ambiguous creation", async (response, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 7200 }))
      .mockImplementation(response);
    const create = createWecomClient(() => ({ corpId: "corp", secret: "secret" }), fetcher);
    await expect(create(input)).rejects.toMatchObject({ code, chatId: input.requestId });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
