import { describe, expect, it, vi } from "vitest";
import { isTransientDbError, withDbRetry } from "./db-pool.js";

describe("isTransientDbError", () => {
  it("flags MySQL shutdown / lost-connection errors", () => {
    expect(isTransientDbError({ code: "PROTOCOL_CONNECTION_LOST" })).toBe(true);
    expect(isTransientDbError({ errno: 1053, message: "Server shutdown in progress" })).toBe(true);
    expect(isTransientDbError({ code: "ECONNRESET" })).toBe(true);
    expect(
      isTransientDbError(new Error("Connection lost: The server closed the connection.")),
    ).toBe(true);
  });

  it("does not retry query/logic errors", () => {
    expect(isTransientDbError({ code: "ER_PARSE_ERROR", errno: 1064 })).toBe(false);
    expect(isTransientDbError({ code: "ER_NO_SUCH_TABLE", errno: 1146 })).toBe(false);
    expect(isTransientDbError(new Error("Unknown column 'x'"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});

describe("withDbRetry", () => {
  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const result = await withDbRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw { code: "PROTOCOL_CONNECTION_LOST" };
        }
        return "ok";
      },
      { baseDelayMs: 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    await expect(
      withDbRetry(
        async () => {
          calls++;
          throw new Error("Unknown column 'x'");
        },
        { baseDelayMs: 0 },
      ),
    ).rejects.toThrow("Unknown column");
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries and rethrows", async () => {
    let calls = 0;
    const err = { code: "ECONNREFUSED" };
    await expect(
      withDbRetry(
        async () => {
          calls++;
          throw err;
        },
        { retries: 2, baseDelayMs: 0 },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(3); // first try + 2 retries
  });

  it("logs a warning per retry when a logger is supplied", async () => {
    const warn = vi.fn();
    await withDbRetry(
      async () => {
        throw { code: "ETIMEDOUT" };
      },
      { retries: 1, baseDelayMs: 0, logger: { warn } as never, label: "test" },
    ).catch(() => {});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
