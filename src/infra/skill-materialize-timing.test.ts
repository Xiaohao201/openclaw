import { afterEach, expect, it, vi } from "vitest";
import { observeSkillMaterialization } from "./skill-materialize-timing.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logs }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("allows a 10-second sync and records individual stages", async () => {
  vi.useFakeTimers();
  const result = observeSkillMaterialization(126, async (timing) => {
    await timing.stage("skills_query", () => new Promise((resolve) => setTimeout(resolve, 2000)));
    return timing.stage(
      "write_files",
      () => new Promise((resolve) => setTimeout(() => resolve(7), 8000)),
    );
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(result).resolves.toBe(7);
  expect(logs.info).toHaveBeenCalledWith(
    "skills materialize timing",
    expect.objectContaining({
      outcome: "success",
      elapsedMs: 10_000,
      stagesMs: { skills_query: 2000, write_files: 8000 },
    }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("times out at 12 seconds and identifies the unfinished stage", async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const result = observeSkillMaterialization(126, (timing) =>
    timing.stage(
      "resources_query",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const rejected = expect(result).rejects.toThrow("skills materialize timed out after 12000ms");
  await vi.advanceTimersByTimeAsync(11_999);
  expect(logs.warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(logs.warn).toHaveBeenCalledWith(
    "skills materialize timing",
    expect.objectContaining({
      outcome: "timeout",
      activeStage: "resources_query",
      activeStageMs: 12_000,
    }),
  );
  finish?.();
  await Promise.resolve();
  expect(logs.info).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("records failures without exposing database errors or leaving timers", async () => {
  vi.useFakeTimers();
  await expect(
    observeSkillMaterialization(126, (timing) =>
      timing.stage("scripts_query", async () => {
        throw new Error("private connection detail");
      }),
    ),
  ).rejects.toThrow("private connection detail");
  expect(logs.warn).toHaveBeenCalledWith(
    "skills materialize timing",
    expect.objectContaining({
      outcome: "error",
      stagesMs: { scripts_query: 0 },
    }),
  );
  expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("private connection detail");
  expect(vi.getTimerCount()).toBe(0);
});
