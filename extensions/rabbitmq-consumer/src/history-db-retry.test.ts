import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeHistoryDbError, retryHistoryMetadataWrite } from "./history-db-retry.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const disconnect = () =>
  Object.assign(new Error("private database address"), { code: "ECONNRESET" });
const context = () => ({
  historyId: 42,
  userId: "962",
  logger: { warn: vi.fn() },
  signal: new AbortController().signal,
});

describe("history metadata retry", () => {
  it("recovers from transient disconnects with bounded exponential backoff and safe context", async () => {
    const ctx = context();
    const write = vi
      .fn()
      .mockRejectedValueOnce(disconnect())
      .mockRejectedValueOnce(disconnect())
      .mockRejectedValueOnce(disconnect())
      .mockResolvedValue(undefined);
    const pending = retryHistoryMetadataWrite(write, ctx);
    await vi.advanceTimersByTimeAsync(549);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1050);
    expect(write).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2050);
    await pending;
    expect(write).toHaveBeenCalledTimes(4);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'historyId=42 userId="962" code=ECONNRESET attempt=1/4 retryInMs=550',
      ),
    );
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain("private database");
  });
  it("stops after four attempts and exposes the code/count without the driver's private message", async () => {
    const write = vi.fn().mockRejectedValue(disconnect());
    const outcome = retryHistoryMetadataWrite(write, context()).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await outcome;
    expect(write).toHaveBeenCalledTimes(4);
    expect(describeHistoryDbError(error)).toBe("code=ECONNRESET attempts=4");
    expect(String(error)).not.toContain("private database");
  });
  it.each(["ER_PARSE_ERROR", "ER_ACCESS_DENIED_ERROR", "ER_BAD_FIELD_ERROR", "UNKNOWN"])(
    "does not retry a permanent error %s",
    async (code) => {
      const write = vi.fn().mockRejectedValue(Object.assign(new Error("private SQL"), { code }));
      const result = retryHistoryMetadataWrite(write, context());
      await expect(result).rejects.toThrow(`code=${code}`);
      expect(write).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([1053, 1040, 1205, 1213])("recognizes transient MySQL errno %s", async (errno) => {
    const write = vi.fn().mockRejectedValueOnce({ errno }).mockResolvedValue(undefined);
    const result = retryHistoryMetadataWrite(write, context());
    await vi.runAllTimersAsync();
    await result;
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("cancels the retry timer on shutdown without starting another query", async () => {
    const controller = new AbortController();
    const write = vi.fn().mockRejectedValue(disconnect());
    const outcome = retryHistoryMetadataWrite(write, {
      ...context(),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("rejects an already stopped operation and sanitizes unknown errors", async () => {
    const controller = new AbortController();
    controller.abort();
    const write = vi.fn();
    await expect(
      retryHistoryMetadataWrite(write, { ...context(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(write).not.toHaveBeenCalled();
    expect(describeHistoryDbError({ code: "secret\nraw SQL" })).toBe("code=UNKNOWN attempts=1");
    expect(describeHistoryDbError(null)).toBe("code=UNKNOWN attempts=1");
  });
});
