import { describe, expect, it } from "vitest";
import { createDeferred } from "../plugin-sdk/extension-shared.js";
import { createServiceWorkTracker } from "./service-work.js";

describe("service work tracking", () => {
  it("settles concurrent drain waiters only after accepted work completes", async () => {
    const tracker = createServiceWorkTracker("shared");
    tracker.resume();
    const pending = createDeferred<void>();
    const task = tracker.run(() => pending.promise);
    const pauses = [tracker.pause(1000), tracker.pause(1000)];
    tracker.closeAdmission();
    await expect(tracker.run(async () => {})).rejects.toThrow("not accepting");
    pending.resolve(undefined);
    await Promise.all([task, ...pauses]);
    tracker.resume();
    const values: number[] = [];
    for await (const value of tracker.stream(async function* () {
      yield 1;
      yield 2;
    })) {
      values.push(value);
    }
    expect(values).toEqual([1, 2]);
    expect(tracker.activeCount()).toBe(0);
  });
  it("rejects standby work and drains the underlying operation without aborting it", async () => {
    const tracker = createServiceWorkTracker("test", false);
    await expect(tracker.run(async () => 1)).rejects.toThrow("not accepting");
    tracker.resume();
    const task = createDeferred<void>();
    const running = tracker.run(() => task.promise);
    await expect(tracker.pause(5)).rejects.toThrow("1 active");
    expect(tracker.activeCount()).toBe(1);
    await expect(tracker.run(async () => 2)).rejects.toThrow("not accepting");
    task.resolve(undefined);
    await running;
    await tracker.pause(100);
    tracker.resume();
    expect(await tracker.run(async () => 3)).toBe(3);
  });

  it("holds a stream lease through iterator cleanup", async () => {
    const tracker = createServiceWorkTracker("stream", true);
    const cleanup = createDeferred<void>();
    async function* source() {
      try {
        yield 1;
      } finally {
        await cleanup.promise;
      }
    }
    const iterator = tracker.stream(source)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    const finishing = iterator.return!();
    await expect(tracker.pause(5)).rejects.toThrow("1 active");
    cleanup.resolve(undefined);
    await finishing;
    await tracker.pause(100);
    expect(tracker.activeCount()).toBe(0);
  });

  it("checks stream admission on iteration and releases failed work", async () => {
    const tracker = createServiceWorkTracker("stream", true);
    const stream = tracker.stream(async function* () {
      yield 1;
    });
    await tracker.pause(100);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("not accepting");
    tracker.resume();
    await expect(
      tracker.run(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(tracker.activeCount()).toBe(0);
  });
});
