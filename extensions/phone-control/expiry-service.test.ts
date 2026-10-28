import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/service-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createPhoneControlExpiryService } from "./expiry-service.js";

const ctx: OpenClawPluginServiceContext = {
  config: {},
  stateDir: "test-state",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  lifecycleMode: "externally-managed",
  handoffVersion: 2,
};
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("stays idle in standby and checks expiry immediately on every resume", async () => {
  vi.useFakeTimers();
  const tick = vi.fn(async () => {});
  const service = createPhoneControlExpiryService(tick);
  expect(service.handoff!.isReady(ctx)).toBe(false);
  await expect(service.handoff!.resume(ctx)).rejects.toThrow("initialized");
  await service.start(ctx);
  await service.start(ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(tick).not.toHaveBeenCalled();
  expect(service.handoff).toMatchObject({ version: 2, drainPhase: "execution" });
  await service.handoff!.resume(ctx);
  await service.handoff!.resume(ctx);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(tick).toHaveBeenCalledTimes(2);
  await service.handoff!.pause(ctx, 100);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(tick).toHaveBeenCalledTimes(2);
  await service.handoff!.resume(ctx);
  expect(tick).toHaveBeenCalledTimes(3);
  await service.stop!(ctx);
  await service.stop!(ctx);
  expect(service.handoff!.isReady(ctx)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for actual writes and does not overlap ticks or abort work on timeout", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<void>();
  const tick = vi.fn(() => pending.promise);
  const service = createPhoneControlExpiryService(tick);
  await service.start(ctx);
  const resumed = service.handoff!.resume(ctx);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(tick).toHaveBeenCalledTimes(1);
  const paused = expect(service.handoff!.pause(ctx, 10)).rejects.toThrow("not aborted");
  await vi.advanceTimersByTimeAsync(10);
  await paused;
  const recovered = service.handoff!.resume(ctx);
  pending.resolve();
  await resumed;
  await recovered;
  expect(tick).toHaveBeenCalledTimes(1);
  await service.handoff!.pause(ctx, 100);
  await service.stop!(ctx);
  expect(vi.getTimerCount()).toBe(0);
});

it("surfaces failed expiry writes in managed mode and retries on resume", async () => {
  vi.useFakeTimers();
  const tick = vi.fn(async () => {}).mockRejectedValueOnce(new Error("write failed"));
  const service = createPhoneControlExpiryService(tick);
  await service.start(ctx);
  await expect(service.handoff!.resume(ctx)).rejects.toThrow("expiry check failed");
  await expect(service.handoff!.pause(ctx, 100)).rejects.toThrow("expiry check failed");
  expect(vi.getTimerCount()).toBe(0);
  await service.handoff!.resume(ctx);
  await service.stop!(ctx);
  expect(tick).toHaveBeenCalledTimes(2);
});

it("retains immediate best-effort polling in ordinary mode and rejects older managed hosts", async () => {
  vi.useFakeTimers();
  const tick = vi.fn(async () => {}).mockRejectedValueOnce(new Error("temporary failure"));
  const service = createPhoneControlExpiryService(tick);
  await expect(service.start({ ...ctx, handoffVersion: undefined })).rejects.toThrow("v2");
  const ordinary = { ...ctx, lifecycleMode: undefined, handoffVersion: undefined };
  await service.start(ordinary);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(tick).toHaveBeenCalledTimes(2);
  await service.stop!(ordinary);
});
