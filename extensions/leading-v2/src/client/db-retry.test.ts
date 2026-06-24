import { describe, expect, it } from "vitest";
import { isTransientDbError, withDbRetry } from "./db-retry.js";

describe("isTransientDbError", () => {
  it("flags MySQL shutdown / lost-connection errors", () => {
    expect(isTransientDbError({ code: "PROTOCOL_CONNECTION_LOST" })).toBe(true);
    expect(isTransientDbError({ errno: 1053, message: "Server shutdown in progress" })).toBe(true);
    expect(isTransientDbError({ code: "ECONNREFUSED" })).toBe(true);
    expect(
      isTransientDbError(new Error("Connection lost: The server closed the connection.")),
    ).toBe(true);
  });

  it("does not retry query/logic errors", () => {
    expect(isTransientDbError({ code: "ER_PARSE_ERROR", errno: 1064 })).toBe(false);
    expect(isTransientDbError({ code: "ER_DUP_ENTRY", errno: 1062 })).toBe(false);
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
          throw { code: "ER_DUP_ENTRY", errno: 1062 };
        },
        { baseDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ errno: 1062 });
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries and rethrows", async () => {
    let calls = 0;
    const err = { code: "ETIMEDOUT" };
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
});
