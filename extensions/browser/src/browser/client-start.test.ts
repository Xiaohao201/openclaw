import { afterEach, describe, expect, it, vi } from "vitest";
import { browserStart } from "./client.js";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("./local-dispatch.runtime.js", () => ({ dispatchBrowserControlRequest: dispatch }));

afterEach(() => {
  vi.useRealTimers();
  dispatch.mockReset();
});

describe("browser cold start", () => {
  it("waits for a new Chrome profile that takes twenty seconds to initialize", async () => {
    vi.useFakeTimers();
    dispatch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return { status: 200, body: { ok: true } };
    });
    const result = browserStart(undefined, { profile: "isolated" }).then(
      () => "started",
      () => "failed",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBe("started");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/start", query: { profile: "isolated" } }),
    );
  });

  it("still stops waiting when browser startup never responds", async () => {
    vi.useFakeTimers();
    dispatch.mockImplementation(() => new Promise(() => {}));
    const result = browserStart().then(
      () => "started",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await result).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
