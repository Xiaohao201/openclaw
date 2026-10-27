import { describe, expect, it, vi } from "vitest";
import { GatewayLifecycleCoordinator, type ManagedWorker } from "./coordinator.js";

function worker(id: string): ManagedWorker {
  return {
    id,
    prepare: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    quiesce: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

describe("external lifecycle coordinator", () => {
  it("cleans up failed initial preparation and permits a later start", async () => {
    const bad = worker("bad");
    vi.mocked(bad.prepare).mockRejectedValue(new Error("invalid release"));
    const manager = new GatewayLifecycleCoordinator();
    await expect(manager.start(bad)).rejects.toThrow("invalid release");
    expect(bad.dispose).toHaveBeenCalledOnce();
    expect(manager.snapshot().phase).toBe("empty");
    await manager.stop();
    await expect(manager.resume()).rejects.toThrow("No worker");
    const next = worker("next");
    await manager.start(next);
    await expect(manager.start(worker("third"))).rejects.toThrow("already active");
    await expect(manager.replace(next)).rejects.toThrow("new worker identity");
  });

  it("keeps the initial worker alive after partial admission and retries safely", async () => {
    const active = worker("active");
    vi.mocked(active.resume).mockRejectedValueOnce(new Error("partial admission"));
    const manager = new GatewayLifecycleCoordinator();
    await expect(manager.start(active)).rejects.toThrow("partial admission");
    expect(active.dispose).not.toHaveBeenCalled();
    await manager.resume();
    vi.mocked(active.quiesce).mockRejectedValueOnce(new Error("busy"));
    await expect(manager.stop()).rejects.toThrow("busy");
    expect(active.dispose).not.toHaveBeenCalled();
    expect(manager.snapshot().phase).toBe("active");
    await manager.stop();
    expect(active.dispose).toHaveBeenCalledOnce();
  });

  it("never kills a candidate after consumption may have started", async () => {
    const old = worker("old");
    const next = worker("next");
    vi.mocked(next.resume).mockRejectedValueOnce(new Error("partial resume"));
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.replace(next)).rejects.toThrow("Replacement owns the service");
    expect(next.dispose).not.toHaveBeenCalled();
    expect(old.activate).toHaveBeenCalledTimes(1);
    await manager.resume();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(manager.snapshot().workerId).toBe("next");
  });
  it("prepares the replacement before touching the active worker", async () => {
    const old = worker("old");
    const next = worker("next");
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await manager.replace(next);
    expect(next.prepare).toHaveBeenCalledOnce();
    expect(vi.mocked(next.prepare).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(old.quiesce).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(next.activate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(old.dispose).mock.invocationCallOrder[0],
    );
    expect(manager.snapshot()).toEqual({ phase: "active", workerId: "next" });
  });

  it("preserves the old service when preloading fails", async () => {
    const old = worker("old");
    const next = worker("next");
    vi.mocked(next.prepare).mockRejectedValue(new Error("bad build"));
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.replace(next)).rejects.toThrow("bad build");
    expect(old.quiesce).not.toHaveBeenCalled();
    expect(old.dispose).not.toHaveBeenCalled();
    expect(manager.snapshot()).toEqual({ phase: "active", workerId: "old" });
  });

  it("resumes admission rather than killing busy work on timeout", async () => {
    const old = worker("old");
    const next = worker("next");
    vi.mocked(old.quiesce).mockRejectedValue(new Error("busy"));
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.replace(next)).rejects.toThrow("busy");
    expect(old.resume).toHaveBeenCalledTimes(2);
    expect(old.deactivate).not.toHaveBeenCalled();
    expect(next.activate).not.toHaveBeenCalled();
  });

  it("terminates a failed candidate before reactivating the old worker", async () => {
    const old = worker("old");
    const next = worker("next");
    vi.mocked(next.activate).mockRejectedValue(new Error("startup failed"));
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.replace(next)).rejects.toThrow("startup failed");
    expect(old.activate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(next.dispose).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(old.activate).mock.invocationCallOrder[1],
    );
    expect(old.dispose).not.toHaveBeenCalled();
    expect(manager.snapshot()).toEqual({ phase: "active", workerId: "old" });
  });

  it("does not start a second writer if candidate termination fails", async () => {
    const old = worker("old");
    const next = worker("next");
    vi.mocked(next.activate).mockRejectedValue(new Error("timeout"));
    vi.mocked(next.dispose).mockRejectedValue(new Error("still alive"));
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.replace(next)).rejects.toThrow();
    expect(old.activate).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().phase).toBe("failed");
  });

  it("rejects concurrent upgrades", async () => {
    const old = worker("old");
    const next = worker("next");
    let prepared!: () => void;
    vi.mocked(next.prepare).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          prepared = resolve;
        }),
    );
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    const replacement = manager.replace(next);
    await expect(manager.replace(worker("third"))).rejects.toThrow(/in progress/);
    prepared();
    await replacement;
  });
});
