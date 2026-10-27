import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../../api.js";
import { ScheduleStore } from "./schedule-store.js";
import { Scheduler, type ScheduleEvent } from "./scheduler.js";
import type { ActionRunner, ScheduledTask } from "./types.js";

const logger: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} } as PluginLogger;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = Date.now();
  return {
    id: "s1",
    uid: "1749",
    title: "刷新A",
    schedule: { kind: "interval", everyMinutes: 5 },
    tz: "Asia/Shanghai",
    action: { tool: "crawl_refresh_create", params: { links: ["https://a.com/1"] } },
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
    mercureTopic: "1749",
    delivery: {},
    enabled: true,
    nextRunAt: now - 1, // due
    failCount: 0,
    createdAt: now,
    ...overrides,
  };
}

describe("Scheduler.tick", () => {
  it("pauses admission without aborting accepted work and resumes later", async () => {
    const store = new ScheduleStore();
    store.add(task());
    let finish!: () => void;
    let wasAborted = false;
    const runner: ActionRunner = async (_task, context) => {
      context?.signal?.addEventListener("abort", () => {
        wasAborted = true;
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true };
    };
    const scheduler = new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger });
    await scheduler.tick();
    const paused = scheduler.pause(1000);
    expect(wasAborted).toBe(false);
    finish();
    await paused;
    expect(scheduler.snapshot()).toEqual({ running: 0, queued: 0 });
    scheduler.start();
    await scheduler.stop();
  });
  it("admits different users before filling their second waiting positions", async () => {
    const store = new ScheduleStore();
    const now = Date.now();
    for (let user = 0; user < 120; user++) {
      for (let index = 0; index < 3; index++) {
        store.add(task({ id: `${user}-${index}`, uid: `u${user}`, nextRunAt: now - 1 }));
      }
    }
    const events: ScheduleEvent[] = [];
    const releases: Array<() => void> = [];
    const runner: ActionRunner = async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    };
    const sched = new Scheduler({
      store,
      runners: { crawl_refresh_create: runner },
      logger,
      onEvent: (event) => events.push(event),
    });
    await sched.tick(now);
    const admitted = events.filter((event) => event.outcome === "queued");
    expect(admitted).toHaveLength(108);
    expect(new Set(admitted.map((event) => event.uid)).size).toBe(108);
    const stopping = sched.stop();
    releases.forEach((release) => release());
    await stopping;
  });

  it("coalesces a running task to one pending occurrence without overlapping executions", async () => {
    let now = Date.now();
    const store = new ScheduleStore();
    store.add(task({ schedule: { kind: "interval", everyMinutes: 1 } }));
    const events: ScheduleEvent[] = [];
    const releases: Array<() => void> = [];
    const runner: ActionRunner = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const sched = new Scheduler({
      store,
      runners: { crawl_refresh_create: runner },
      logger,
      now: () => now,
      onEvent: (event) => events.push(event),
    });
    await sched.tick();
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      await sched.tick();
    }
    expect(sched.snapshot()).toEqual({ running: 1, queued: 1 });
    expect(events.filter((event) => event.outcome === "merged")).toHaveLength(2);
    releases.shift()!();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    expect(sched.snapshot()).toEqual({ running: 1, queued: 0 });
    const stopping = sched.stop();
    releases.shift()!();
    await stopping;
  });

  it("stops scans and requests cancellation without counting shutdown as a failure", async () => {
    vi.useFakeTimers();
    try {
      const store = new ScheduleStore();
      store.add(task());
      const runner = vi.fn<ActionRunner>(async (_task, execution) => {
        await new Promise<void>((resolve) =>
          execution!.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: false, code: "cancelled", note: "shutdown" };
      });
      const events: ScheduleEvent[] = [];
      const sched = new Scheduler({
        store,
        runners: { crawl_refresh_create: runner },
        logger,
        onEvent: (event) => events.push(event),
      });
      sched.start();
      sched.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runner).toHaveBeenCalledOnce();
      await sched.stop();
      await sched.tick();
      expect(store.get("s1")!.failCount).toBe(0);
      expect(events.at(-1)?.outcome).toBe("cancelled");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records runner failures even if the optional journal observer fails", async () => {
    const store = new ScheduleStore();
    store.add(task());
    const sched = new Scheduler({
      store,
      runners: {},
      logger,
      onEvent: () => {
        throw new Error("disk unavailable");
      },
    });
    await sched.tick();
    await vi.waitFor(() => expect(store.get("s1")!.failCount).toBe(1));
    await sched.stop();
  });

  it("admits eight users without waiting for their long runs and drains fairly", async () => {
    const store = new ScheduleStore();
    const releases: Array<() => void> = [];
    const started: string[] = [];
    for (let i = 0; i < 12; i++) {
      store.add(task({ id: `s${i}`, uid: `u${i}` }));
    }
    const runner: ActionRunner = vi.fn(async (t) => {
      started.push(t.id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const sched = new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger });
    await sched.tick();
    expect(started).toHaveLength(8);
    releases.shift()!();
    await vi.waitFor(() => expect(started).toHaveLength(9));
    const stopping = sched.stop();
    releases.forEach((release) => release());
    await stopping;
    expect(started).toHaveLength(9);
  });

  it("merges repeated triggers, limits each user and drops expired work without failures", async () => {
    let now = Date.now();
    const store = new ScheduleStore();
    store.add(task({ id: "a", schedule: { kind: "interval", everyMinutes: 1 } }));
    store.add(task({ id: "b" }));
    store.add(task({ id: "c" }));
    store.add(task({ id: "d" }));
    const releases: Array<() => void> = [];
    const runner: ActionRunner = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const sched = new Scheduler({
      store,
      runners: { crawl_refresh_create: runner },
      logger,
      now: () => now,
    });
    await sched.tick(now);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sched.snapshot()).toMatchObject({ running: 1, queued: 2 });
    now += 60_000;
    await sched.tick(now);
    expect(sched.snapshot().queued).toBe(2);
    now += 10 * 60_000;
    await sched.tick(now);
    // Expired occurrences are not immediately re-admitted during this tick.
    expect(store.get("b")!.failCount).toBe(0);
    expect(store.get("c")!.failCount).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    const stopping = sched.stop();
    releases.forEach((release) => release());
    await stopping;
  });

  it("bounds the global queue and never launches a deleted queued task", async () => {
    const store = new ScheduleStore();
    for (let i = 0; i < 120; i++) {
      store.add(task({ id: `s${i}`, uid: `u${i}` }));
    }
    const releases: Array<() => void> = [];
    const runner: ActionRunner = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const sched = new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger });
    await sched.tick();
    expect(sched.snapshot()).toMatchObject({ running: 8, queued: 100 });
    store.remove("s8");
    releases.shift()!();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(9));
    expect(vi.mocked(runner).mock.calls.map(([t]) => t.id)).not.toContain("s8");
    const stopping = sched.stop();
    releases.forEach((release) => release());
    await stopping;
  });

  it("runs a due task and reschedules nextRunAt forward", async () => {
    const store = new ScheduleStore();
    store.add(task());
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: true, note: "uuid" });
    const sched = new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger });

    const now = Date.now();
    await sched.tick(now);

    expect(runner).toHaveBeenCalledOnce();
    const updated = store.get("s1")!;
    expect(updated.nextRunAt).toBe(now + 5 * 60_000);
    expect(updated.lastRunAt).toBe(now);
    expect(updated.enabled).toBe(true);
  });

  it("does not run a task that is not yet due", async () => {
    const store = new ScheduleStore();
    store.add(task({ nextRunAt: Date.now() + 3_600_000 }));
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: true });
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick();
    expect(runner).not.toHaveBeenCalled();
  });

  it("skips disabled tasks", async () => {
    const store = new ScheduleStore();
    store.add(task({ enabled: false }));
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: true });
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick();
    expect(runner).not.toHaveBeenCalled();
  });

  it("counts failures and auto-disables after 5", async () => {
    const store = new ScheduleStore();
    store.add(task({ failCount: 4 }));
    const runner: ActionRunner = vi.fn().mockResolvedValue({ ok: false, note: "boom" });
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick();
    await vi.waitFor(() => expect(store.get("s1")!.failCount).toBe(5));
    const updated = store.get("s1")!;
    expect(updated.failCount).toBe(5);
    expect(updated.enabled).toBe(false);
  });

  it("still reschedules when the runner throws", async () => {
    const store = new ScheduleStore();
    store.add(task());
    const runner: ActionRunner = vi.fn().mockRejectedValue(new Error("x"));
    const now = Date.now();
    await new Scheduler({ store, runners: { crawl_refresh_create: runner }, logger }).tick(now);
    await vi.waitFor(() => expect(store.get("s1")!.failCount).toBe(1));
    const updated = store.get("s1")!;
    expect(updated.nextRunAt).toBe(now + 5 * 60_000);
    expect(updated.failCount).toBe(1);
  });
});
