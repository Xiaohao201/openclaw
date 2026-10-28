import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchTransport } from "./search-transport.js";

const params = {
  url: "https://search.example/api",
  timeoutSeconds: 90,
  body: { word: ["Example"] },
};
const ok = { ok: true, status: 200, statusText: "OK", text: "{}", truncated: false };

afterEach(() => vi.useRealTimers());

describe("search transport", () => {
  it("serializes the same endpoint and spaces requests after completion", async () => {
    vi.useFakeTimers();
    const started: number[] = [];
    const request = vi.fn(async () => {
      started.push(Date.now());
      return ok;
    });
    const run = createSearchTransport(request);
    const first = run(params);
    const second = run(params);
    await first;
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    await second;
    expect(started[1] - started[0]).toBe(3000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([429, 400, 503])("retries a transient %s once inside the tool", async (status) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...ok,
        ok: false,
        status,
        text: JSON.stringify({ detail: "请求频率过高,请稍后再试" }),
        retryAfterMs: 7000,
      })
      .mockResolvedValue(ok);
    const promise = createSearchTransport(request)(params);
    await vi.advanceTimersByTimeAsync(6999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual(ok);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry validation errors or indefinitely retry rate limits", async () => {
    vi.useFakeTimers();
    const invalid = vi.fn(async () => ({
      ...ok,
      ok: false,
      status: 400,
      text: '{"detail":"invalid date"}',
    }));
    await createSearchTransport(invalid)(params);
    expect(invalid).toHaveBeenCalledTimes(1);
    const limited = vi.fn(async () => ({ ...ok, ok: false, status: 429 }));
    const promise = createSearchTransport(limited)(params);
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe(429);
    expect(limited).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels queued work without sending another billed request", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ok);
    const run = createSearchTransport(request);
    await run(params);
    const controller = new AbortController();
    const pending = run({ ...params, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await vi.runAllTimersAsync();
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry transport exceptions or delay another endpoint", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(ok);
    const run = createSearchTransport(request);
    await expect(run(params)).rejects.toThrow("offline");
    await expect(run({ ...params, url: "https://other.example/api" })).resolves.toEqual(ok);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("cancels immediately while another request is still in flight", async () => {
    let finish!: (value: typeof ok) => void;
    const request = vi.fn(
      () =>
        new Promise<typeof ok>((resolve) => {
          finish = resolve;
        }),
    );
    const run = createSearchTransport(request);
    const first = run(params);
    await Promise.resolve();
    const controller = new AbortController();
    const pending = run({ ...params, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    finish(ok);
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("honors a long Retry-After for the next queued query without retrying the first", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...ok, ok: false, status: 429, retryAfterMs: 120_000 })
      .mockResolvedValue(ok);
    const run = createSearchTransport(request);
    expect((await run(params)).status).toBe(429);
    const next = run(params);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toEqual(ok);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
