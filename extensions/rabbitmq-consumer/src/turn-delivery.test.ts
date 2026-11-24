import { expect, it, vi } from "vitest";
import { guardTurnDelivery } from "./turn-delivery.js";

it("suppresses every late output surface without affecting another turn", async () => {
  const pusher = {
    pushText: vi.fn(async () => true),
    pushProgress: vi.fn(async () => true),
    pushStep: vi.fn(async () => true),
    pushCitations: vi.fn(async () => true),
    pushReportCreated: vi.fn(async () => true),
    pushError: vi.fn(async () => true),
    pushDone: vi.fn(async () => true),
    pushBrowserAssistance: vi.fn(async () => true),
  };
  const controller = new AbortController();
  const old = guardTurnDelivery(pusher, () => controller.signal.aborted);
  const next = guardTurnDelivery(pusher, () => false);
  await old.pushText("topic", "before", 1);
  controller.abort();
  await old.pushText("topic", "late", 1);
  await old.pushProgress("topic", "late", 1);
  await old.pushCitations("topic", [], 1);
  await old.pushReportCreated("topic", 1);
  await old.pushError("topic", "late", 1);
  await old.pushDone("topic", 1);
  await old.pushBrowserAssistance?.("topic", { status: "waiting" }, 1);
  await old.pushStep(
    "topic",
    {
      stepId: "late",
      phase: "end",
      index: 1,
      label: "late",
      category: "default",
      status: "completed",
    },
    1,
  );
  await next.pushText("topic", "new", 2);
  expect(pusher.pushText.mock.calls).toEqual([
    ["topic", "before", 1],
    ["topic", "new", 2],
  ]);
  for (const method of [
    pusher.pushProgress,
    pusher.pushStep,
    pusher.pushCitations,
    pusher.pushReportCreated,
    pusher.pushError,
    pusher.pushDone,
    pusher.pushBrowserAssistance,
  ]) {
    expect(method).not.toHaveBeenCalled();
  }
});
