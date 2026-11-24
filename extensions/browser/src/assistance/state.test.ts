import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistanceRequest } from "./state.js";

describe("browser assistance lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("checks the page before resuming and does not resume twice", async () => {
    const verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const request = new AssistanceRequest({ timeoutMs: 10_000, verify });
    expect(await request.complete()).toBe(false);
    expect(request.status).toBe("waiting");
    expect(await request.complete()).toBe(true);
    await expect(request.done).resolves.toBe("resumed");
    expect(await request.complete()).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("cancellation wins while a page check is in flight", async () => {
    let finish!: (value: boolean) => void;
    const request = new AssistanceRequest({
      timeoutMs: 10_000,
      verify: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    });
    const completing = request.complete();
    request.cancel();
    finish(true);
    expect(await completing).toBe(false);
    await expect(request.done).resolves.toBe("cancelled");
  });

  it("deduplicates concurrent completion requests", async () => {
    let finish!: (value: boolean) => void;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const request = new AssistanceRequest({ timeoutMs: 10_000, verify });
    const first = request.complete();
    const second = request.complete();
    finish(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("expires and ignores late completion", async () => {
    vi.useFakeTimers();
    const verify = vi.fn();
    const request = new AssistanceRequest({ timeoutMs: 100, verify });
    await vi.advanceTimersByTimeAsync(100);
    await expect(request.done).resolves.toBe("expired");
    expect(await request.complete()).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it("observes a pre-aborted run and cleans up after normal completion", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new AssistanceRequest({
      timeoutMs: 100,
      signal: controller.signal,
      verify: async () => true,
    });
    await expect(request.done).resolves.toBe("cancelled");
    expect(await request.complete()).toBe(false);
  });

  it("a failed check makes the request unavailable", async () => {
    const request = new AssistanceRequest({
      timeoutMs: 100,
      verify: async () => {
        throw new Error("closed");
      },
    });
    expect(await request.complete()).toBe(false);
    await expect(request.done).resolves.toBe("unavailable");
  });
});
