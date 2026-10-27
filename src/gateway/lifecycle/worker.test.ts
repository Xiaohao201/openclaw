import { describe, expect, it, vi } from "vitest";
import type { LifecycleCommand } from "./protocol.js";
import { GatewayLifecycleWorker, type WorkerRuntime } from "./worker.js";

function fixture() {
  const runtime: WorkerRuntime = {
    activate: vi.fn(async () => {}),
    quiesce: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
  };
  const worker = new GatewayLifecycleWorker(runtime);
  const send = (action: LifecycleCommand["action"]) =>
    worker.handle({ protocol: "openclaw-lifecycle-v1", id: action, action, timeoutMs: 100 });
  return { runtime, send };
}

describe("managed worker protocol", () => {
  it("rejects invalid transitions and treats repeated admission as idempotent", async () => {
    const { runtime, send } = fixture();
    expect((await send("status")).state).toBe("prepared");
    expect((await send("quiesce")).ok).toBe(false);
    expect((await send("resume")).ok).toBe(false);
    await send("activate");
    expect((await send("activate")).ok).toBe(false);
    await send("resume");
    await send("resume");
    expect(runtime.resume).toHaveBeenCalledOnce();
  });

  it("never closes an active worker without first draining it", async () => {
    const { runtime, send } = fixture();
    await send("activate");
    await send("resume");
    expect((await send("deactivate")).ok).toBe(false);
    expect(runtime.deactivate).not.toHaveBeenCalled();
    await send("quiesce");
    expect((await send("deactivate")).state).toBe("prepared");
    expect((await send("activate")).state).toBe("quiesced");
  });
  it("can resume after an incomplete drain without resetting running tasks", async () => {
    const { runtime, send } = fixture();
    vi.mocked(runtime.quiesce).mockRejectedValue(new Error("busy"));
    await send("activate");
    await send("resume");
    expect((await send("quiesce")).ok).toBe(false);
    expect((await send("deactivate")).ok).toBe(false);
    expect((await send("resume")).state).toBe("active");
    expect(runtime.deactivate).not.toHaveBeenCalled();
  });
});
