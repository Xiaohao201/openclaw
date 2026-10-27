import type { PluginLogger } from "../../api.js";
import { computeNext } from "./compute-next.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { ActionRunner, ScheduledTask } from "./types.js";

const MAX_FAILS = 5;
export const SCHEDULE_LIMITS = {
  concurrency: 8,
  queued: 100,
  queuedPerUser: 2,
  queueTtlMs: 10 * 60_000,
} as const;

export type ScheduleEvent = {
  taskId: string;
  uid: string;
  at: number;
  outcome:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "merged"
    | "queue_full"
    | "user_queue_full"
    | "queue_expired"
    | "cancelled";
  note?: string;
};

export interface SchedulerDeps {
  store: ScheduleStore;
  runners: Record<string, ActionRunner>;
  logger: PluginLogger;
  tickIntervalMs?: number;
  now?: () => number;
  onEvent?: (event: ScheduleEvent) => void;
}

type Waiting = { task: ScheduledTask; queuedAt: number };

/** Single-owner scheduler. Admission is bounded; model lifetime owns the slot. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  private readonly queue = new Map<string, Waiting>();
  private readonly active = new Map<
    number,
    { task: ScheduledTask; work: Promise<void>; controller: AbortController }
  >();
  private readonly now: () => number;
  private lastUser: string | undefined;
  private lastAdmittedUser: string | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.deps.logger.error(`[LEADING_V2_SCHED] Scan failed: ${String(error)}`);
      });
    }, this.deps.tickIntervalMs ?? 60_000);
    this.timer.unref?.();
    this.deps.logger.info(
      `[LEADING_V2_SCHED] Scheduler started ${JSON.stringify(SCHEDULE_LIMITS)}`,
    );
  }

  /** Stop admission and drain accepted work before closing shared DB/runtime resources. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
    for (const entry of this.queue.values()) {
      this.emit(entry.task, "cancelled", "service stopping");
    }
    this.queue.clear();
    for (const { controller } of this.active.values()) {
      controller.abort();
    }
    await Promise.all([...this.active.values()].map(({ work }) => work));
  }

  snapshot(): { running: number; queued: number } {
    return { running: this.active.size, queued: this.queue.size };
  }

  /** Scans never wait for model execution; overlapping scans are suppressed. */
  async tick(now = this.now()): Promise<void> {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      await this.deps.store.flush();
      await this.deps.store.reload();
      if (this.stopped) {
        return;
      }
      const expired = this.prune(now);
      this.drain(now);
      const due = this.fairDue(now);
      for (const task of due) {
        // Advance even rejected occurrences: never build a backlog of missed intervals.
        this.deps.store.update(task.id, { nextRunAt: computeNext(task.schedule, now, task.tz) });
        if (expired.has(task.id)) {
          continue;
        }
        if (this.queue.has(task.id)) {
          this.emit(task, "merged");
          continue;
        }
        const userQueued = [...this.queue.values()].filter(
          (entry) => entry.task.uid === task.uid,
        ).length;
        if (userQueued >= SCHEDULE_LIMITS.queuedPerUser) {
          this.emit(task, "user_queue_full");
          continue;
        }
        if (this.queue.size >= SCHEDULE_LIMITS.queued) {
          this.emit(task, "queue_full");
          continue;
        }
        this.queue.set(task.id, { task, queuedAt: now });
        this.lastAdmittedUser = task.uid;
        this.emit(task, "queued");
        this.drain(now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Offer each due user admission before considering their second task. */
  private fairDue(now: number): ScheduledTask[] {
    const grouped = new Map<string, ScheduledTask[]>();
    for (const task of this.deps.store
      .due(now)
      .toSorted((a, b) => a.nextRunAt - b.nextRunAt || a.id.localeCompare(b.id))) {
      const tasks = grouped.get(task.uid) ?? [];
      tasks.push(task);
      grouped.set(task.uid, tasks);
    }
    const users = [...grouped.keys()];
    const cursor = users.findIndex((uid) => uid === this.lastAdmittedUser);
    const ordered = [...users.slice(cursor + 1), ...users.slice(0, cursor + 1)];
    const result: ScheduledTask[] = [];
    for (let index = 0; ; index++) {
      let found = false;
      for (const uid of ordered) {
        const task = grouped.get(uid)?.[index];
        if (task) {
          result.push(task);
          found = true;
        }
      }
      if (!found) {
        return result;
      }
    }
  }

  private prune(now: number): Set<string> {
    const expired = new Set<string>();
    for (const [id, entry] of this.queue) {
      const current = this.deps.store.get(id);
      if (!current?.enabled || current.uid !== entry.task.uid) {
        this.queue.delete(id);
        this.emit(entry.task, "cancelled", "schedule removed, disabled, or reassigned");
      } else if (now - entry.queuedAt >= SCHEDULE_LIMITS.queueTtlMs) {
        this.queue.delete(id);
        expired.add(id);
        this.emit(entry.task, "queue_expired");
      }
    }
    return expired;
  }

  private drain(now = this.now()): void {
    if (this.stopped) {
      return;
    }
    this.prune(now);
    while (this.active.size < SCHEDULE_LIMITS.concurrency) {
      const users = new Set([...this.active.values()].map(({ task }) => task.uid));
      const taskIds = new Set([...this.active.values()].map(({ task }) => task.id));
      const eligible = [...this.queue.values()].filter(
        ({ task }) => !users.has(task.uid) && !taskIds.has(task.id),
      );
      const entry = eligible.find(({ task }) => task.uid !== this.lastUser) ?? eligible[0];
      if (!entry) {
        return;
      }
      this.queue.delete(entry.task.id);
      const task = this.deps.store.get(entry.task.id);
      if (!task?.enabled) {
        continue;
      }
      let slot = 0;
      while (this.active.has(slot)) {
        slot++;
      }
      this.lastUser = task.uid;
      this.deps.store.update(task.id, { lastRunAt: now });
      this.emit(task, "running");
      // Install the reservation before calling any asynchronous runner.
      const controller = new AbortController();
      const work = Promise.resolve()
        .then(() => this.runOne(task, slot, controller.signal))
        .finally(() => {
          this.active.delete(slot);
          this.drain();
        });
      this.active.set(slot, { task, work, controller });
    }
  }

  private async runOne(task: ScheduledTask, slot: number, signal: AbortSignal): Promise<void> {
    try {
      const runner = this.deps.runners[task.action.tool];
      if (!runner) {
        this.recordFail(task, "action runner unavailable");
        return;
      }
      if (signal.aborted) {
        this.emit(task, "cancelled", "service stopping");
        return;
      }
      const result = await runner(task, { lane: `leading-v2-schedule-${slot}`, signal });
      if (result.ok) {
        this.deps.store.update(task.id, { failCount: 0 });
        this.emit(task, "completed");
      } else if (result.code === "cancelled") {
        this.emit(task, "cancelled", result.note);
      } else {
        this.recordFail(task, result.note ?? "runner returned ok=false");
      }
    } catch (error) {
      this.recordFail(task, String(error));
    }
  }

  private recordFail(task: ScheduledTask, note: string): void {
    const failCount = (this.deps.store.get(task.id)?.failCount ?? task.failCount) + 1;
    this.deps.store.update(task.id, {
      failCount,
      ...(failCount >= MAX_FAILS ? { enabled: false } : {}),
    });
    this.emit(task, "failed", note);
  }

  private emit(task: ScheduledTask, outcome: ScheduleEvent["outcome"], note?: string): void {
    const event: ScheduleEvent = {
      taskId: task.id,
      uid: task.uid,
      at: this.now(),
      outcome,
      ...(note ? { note: note.slice(0, 1000) } : {}),
    };
    this.deps.logger.info(`[LEADING_V2_SCHED] ${JSON.stringify(event)}`);
    try {
      this.deps.onEvent?.(event);
    } catch (error) {
      this.deps.logger.error(`[LEADING_V2_SCHED] Event persistence failed: ${String(error)}`);
    }
  }
}
