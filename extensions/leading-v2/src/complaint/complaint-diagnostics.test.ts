import { describe, expect, it } from "vitest";
import { safeErrorFields, createExecutorDiagnosticStream } from "./complaint-diagnostics.js";

describe("complaint diagnostics", () => {
  it("keeps driver codes but never includes SQL, credentials or exception messages", () => {
    expect(
      safeErrorFields(
        Object.assign(new Error("password secret"), {
          code: "ETIMEDOUT",
          errno: 1205,
          sqlState: "HY000",
          sql: "private SQL",
        }),
      ),
    ).toEqual({ errorType: "Error", code: "ETIMEDOUT", errno: 1205, sqlState: "HY000" });
  });
  it("handles split lines and discards raw, oversized and unrecognized diagnostics", () => {
    const events: unknown[] = [];
    const stream = createExecutorDiagnosticStream((event) => events.push(event));
    stream('raw secret\nOPENCLAW_DIAGNOSTIC {"stage":"navigate",');
    stream('"errorType":"TimeoutError","message":"secret"}\n');
    stream("x".repeat(10000));
    stream('OPENCLAW_DIAGNOSTIC {"stage":"forged"}\n');
    stream('OPENCLAW_DIAGNOSTIC {"stage":"submit"}\n');
    expect(events).toEqual([{ stage: "navigate", errorType: "TimeoutError" }, { stage: "submit" }]);
  });
});
