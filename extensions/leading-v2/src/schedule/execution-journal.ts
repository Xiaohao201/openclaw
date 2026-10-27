import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ScheduleEvent } from "./scheduler.js";

const eventsSchema = Type.Array(
  Type.Object({
    taskId: Type.String(),
    uid: Type.String(),
    at: Type.Number(),
    outcome: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("merged"),
      Type.Literal("queue_full"),
      Type.Literal("user_queue_full"),
      Type.Literal("queue_expired"),
      Type.Literal("cancelled"),
    ]),
    note: Type.Optional(Type.String()),
  }),
);
const KEEP_EVENTS = 1000;

/** Bounded local diagnostics, independent of the business DB during an outage. */
export class ExecutionJournal {
  private events: ScheduleEvent[] = [];
  private dirty = false;
  private writing: Promise<void> | undefined;

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Value.Check(eventsSchema, parsed)) {
        throw new Error("Invalid execution journal schema");
      }
      this.events = parsed.slice(-KEEP_EVENTS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warn(`[LEADING_V2_SCHED] Cannot load execution journal: ${String(error)}`);
      }
    }
  }

  record(event: ScheduleEvent): void {
    this.events.push(event);
    if (this.events.length > KEEP_EVENTS) {
      this.events.splice(0, this.events.length - KEEP_EVENTS);
    }
    this.dirty = true;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (!this.writing) {
      this.writing = this.write().finally(() => {
        this.writing = undefined;
        if (this.dirty) {
          this.scheduleWrite();
        }
      });
    }
  }

  async flush(): Promise<void> {
    while (this.writing) {
      await this.writing;
    }
  }

  private async write(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      while (this.dirty) {
        this.dirty = false;
        // Coalesce bursts instead of queuing a file write per streaming event.
        await writeFile(`${this.path}.tmp`, JSON.stringify(this.events), "utf8");
        await rename(`${this.path}.tmp`, this.path);
      }
    } catch (error) {
      // Retry with the next event, not in a tight loop while the disk is unavailable.
      this.dirty = false;
      this.warn(`[LEADING_V2_SCHED] Cannot save execution journal: ${String(error)}`);
    }
  }
}
