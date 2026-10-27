import { describe, expect, it, vi } from "vitest";
import { TaskPoller } from "./task-poller.js";
import type { ReportTask } from "./types.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("report polling handoff", () => {
  it("finishes the current report and leaves unclaimed rows for the next worker", async () => {
    const poller = new TaskPoller(
      { host: "localhost", port: 3306, user: "test", password: "test", database: "test" },
      1000,
    );
    vi.spyOn(poller, "requeueStaleRunning").mockResolvedValue(0);
    vi.spyOn(poller, "fetchPendingTasks").mockResolvedValue([{ id: 1 }, { id: 2 }] as ReportTask[]);
    let finish!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    poller.start(logger, execute);
    await running;
    const pause = poller.pause(1000);
    finish();
    await pause;
    expect(execute).toHaveBeenCalledOnce();
    await poller.stop(logger);
  });
});
