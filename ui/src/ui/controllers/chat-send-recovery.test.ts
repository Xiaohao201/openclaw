import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, GatewayTransportError } from "../gateway.ts";
import { sendChatWithRecovery } from "./chat-send-recovery.ts";

describe("chat deployment recovery", () => {
  it("retries only a proven rejection, then tolerates reconnect before sending", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "draining",
          retryable: true,
          details: { notAccepted: true },
        }),
      )
      .mockRejectedValueOnce(new GatewayTransportError("offline", "not-sent"))
      .mockResolvedValue({});
    await sendChatWithRecovery({ send, isCurrent: () => true, wait: async () => {} });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("never replays a request whose response was lost", async () => {
    const send = vi.fn().mockRejectedValue(new GatewayTransportError("closed", "unknown"));
    await expect(sendChatWithRecovery({ send, isCurrent: () => true })).rejects.toThrow("closed");
    expect(send).toHaveBeenCalledOnce();
  });
  it("does not treat generic retryable errors as proof of non-execution", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "unknown", retryable: true }),
      );
    await expect(sendChatWithRecovery({ send, isCurrent: () => true })).rejects.toThrow("unknown");
    expect(send).toHaveBeenCalledOnce();
  });
  it("stops when the session/client changes or the deadline expires", async () => {
    const send = vi.fn().mockRejectedValue(new GatewayTransportError("offline", "not-sent"));
    await expect(sendChatWithRecovery({ send, isCurrent: () => false })).rejects.toThrow();
    let now = 0;
    await expect(
      sendChatWithRecovery({
        send,
        isCurrent: () => true,
        now: () => now,
        timeoutMs: 1,
        wait: async () => {
          now = 2;
        },
      }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
