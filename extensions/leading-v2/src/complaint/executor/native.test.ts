import { describe, expect, it, vi } from "vitest";
import { ComplaintNeedsOperator, executeNativeComplaint } from "./native.js";

function fixture() {
  const controller = new AbortController();
  const driver = {
    navigate: vi.fn().mockResolvedValue(undefined),
    checkLogin: vi.fn().mockResolvedValue(true),
    prepare: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(true),
    screenshot: vi.fn().mockResolvedValue({
      fileName: "a".repeat(32) + ".png",
      capturedAt: new Date().toISOString(),
    }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const acquire = vi.fn().mockResolvedValue(driver);
  return {
    controller,
    driver,
    acquire,
    run: () =>
      executeNativeComplaint({
        acquire,
        signal: controller.signal,
        timeoutMs: 10000,
        log: vi.fn(),
      }),
  };
}

describe("native complaint state machine", () => {
  it("logs the failing prepare step without leaking the exception message", async () => {
    const f = fixture();
    const log = vi.fn();
    f.driver.prepare.mockImplementation(async (onStep?: (step: "wait_report_form") => void) => {
      onStep?.("wait_report_form");
      throw Object.assign(new Error("private URL and credentials"), { name: "TimeoutError" });
    });
    await executeNativeComplaint({
      acquire: f.acquire,
      signal: f.controller.signal,
      timeoutMs: 10000,
      log,
    });
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: "prepare",
        step: "wait_report_form",
        attempted: false,
        errorType: "TimeoutError",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(f.driver.submit).not.toHaveBeenCalled();
  });
  it("does not acquire an already-expired execution", async () => {
    const f = fixture();
    expect(
      await executeNativeComplaint({
        acquire: f.acquire,
        signal: f.controller.signal,
        timeoutMs: 0,
        log: vi.fn(),
      }),
    ).toMatchObject({ state: "failed", errorCode: "EXECUTION_TIMEOUT" });
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it("does not carry a prepare step into a submission failure", async () => {
    const f = fixture();
    const log = vi.fn();
    f.driver.prepare.mockImplementation(async (onStep?: (step: "check_submit") => void) => {
      onStep?.("check_submit");
    });
    f.driver.submit.mockRejectedValue(new Error("fixture"));
    await executeNativeComplaint({
      acquire: f.acquire,
      signal: f.controller.signal,
      timeoutMs: 10000,
      log,
    });
    expect(log.mock.lastCall?.[0]).toMatchObject({ stage: "submit", attempted: true });
    expect(log.mock.lastCall?.[0]).not.toHaveProperty("step");
  });
  it("stops before submission when the category requires operator review", async () => {
    const f = fixture();
    f.driver.prepare.mockRejectedValue(
      new ComplaintNeedsOperator("CATEGORY_REQUIRED", "fixture category"),
    );
    expect(await f.run()).toMatchObject({
      state: "manual_required",
      errorCode: "CATEGORY_REQUIRED",
    });
    expect(f.driver.submit).not.toHaveBeenCalled();
    expect(f.driver.release).toHaveBeenCalledOnce();
  });
  it("requires a positive receipt, captures evidence, and releases once", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({
      state: "done",
      screenshot: { fileName: "a".repeat(32) + ".png" },
    });
    expect(f.driver.submit).toHaveBeenCalledTimes(1);
    expect(f.driver.release).toHaveBeenCalledTimes(1);
  });
  it("does not submit without a positive login check", async () => {
    const f = fixture();
    f.driver.checkLogin.mockResolvedValue(false);
    expect(await f.run()).toMatchObject({ state: "manual_required", errorCode: "LOGIN_REQUIRED" });
    expect(f.driver.submit).not.toHaveBeenCalled();
  });
  it("keeps a successful submission when screenshot or cleanup fails", async () => {
    const f = fixture();
    f.driver.screenshot.mockRejectedValue(new Error("capture failed"));
    f.driver.release.mockRejectedValue(new Error("disconnect failed"));
    expect(await f.run()).toMatchObject({
      state: "done",
      evidenceError: "SCREENSHOT_CAPTURE_FAILED",
    });
    expect(f.driver.submit).toHaveBeenCalledTimes(1);
  });
  it.each(["submit", "verify"] as const)(
    "never retries when %s fails after a possible submission",
    async (method) => {
      const f = fixture();
      f.driver[method].mockRejectedValue(new Error("private URL"));
      expect(await f.run()).toMatchObject({ state: "unknown", errorCode: "EXECUTION_INTERRUPTED" });
      expect(f.driver.submit).toHaveBeenCalledTimes(1);
      expect(f.driver.release).toHaveBeenCalledTimes(1);
    },
  );
  it("returns unknown without a positive receipt", async () => {
    const f = fixture();
    f.driver.verify.mockResolvedValue(false);
    expect(await f.run()).toMatchObject({ state: "unknown" });
  });
  it("waits for an in-flight operation to settle before releasing on cancellation", async () => {
    const f = fixture();
    let finish!: () => void;
    f.driver.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const run = f.run();
    await vi.waitFor(() => expect(f.driver.prepare).toHaveBeenCalled());
    f.controller.abort();
    expect(f.driver.release).not.toHaveBeenCalled();
    finish();
    expect(await run).toMatchObject({ state: "failed", errorCode: "EXECUTION_CANCELLED" });
    expect(f.driver.submit).not.toHaveBeenCalled();
  });
  it("does not connect when already cancelled", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await f.run()).toMatchObject({ state: "failed" });
    expect(f.acquire).not.toHaveBeenCalled();
  });
});
