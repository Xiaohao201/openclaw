import { describe, expect, it, vi } from "vitest";
import { DeployCoordinator, type DeployWorker } from "../../scripts/deploy-coordinator.js";

function fixture() {
  const events: string[] = [];
  const worker = (name: string): DeployWorker => ({
    activate: vi.fn(async () => {
      events.push(`${name}:activate`);
    }),
    retire: vi.fn(async () => {
      events.push(`${name}:exit`);
    }),
    discard: vi.fn(async () => {
      events.push(`${name}:discard`);
    }),
  });
  const old = worker("old"),
    next = worker("next"),
    rollback = worker("rollback");
  const prepare = vi.fn(async (release: string) => {
    events.push(`prepare:${release}`);
    return release === "new" ? next : rollback;
  });
  const coordinator = new DeployCoordinator({
    release: "old",
    worker: old,
    prepare,
    route: (target) => {
      events.push(target ? "route:open" : "route:closed");
    },
    record: async (phase) => {
      events.push(phase);
    },
  });
  return { coordinator, events, old, next, rollback, prepare };
}
describe("deployment ownership", () => {
  it("prepares without interrupting old and activates only after old exit", async () => {
    const f = fixture();
    await expect(f.coordinator.deploy("new", true)).resolves.toBe("deployed");
    expect(f.events).toEqual([
      "preparing",
      "prepare:new",
      "draining",
      "route:closed",
      "old:exit",
      "activating",
      "next:activate",
      "running",
      "route:open",
    ]);
  });
  it("restores previous code only after failed candidate exits", async () => {
    const f = fixture();
    vi.mocked(f.next.activate).mockRejectedValue(new Error("startup failed"));
    await expect(f.coordinator.deploy("new", true)).resolves.toBe("rolled-back");
    expect(f.events.indexOf("next:discard")).toBeLessThan(f.events.indexOf("rollback:activate"));
    expect(f.events.at(-1)).toBe("route:open");
  });
  it("never activates candidate if old cannot drain", async () => {
    const f = fixture();
    vi.mocked(f.old.retire).mockRejectedValue(new Error("drain failed"));
    await expect(f.coordinator.deploy("new", true)).rejects.toThrow("drain failed");
    expect(f.next.activate).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("blocked");
  });
  it("does not roll back while a candidate might still be writing", async () => {
    const f = fixture();
    vi.mocked(f.next.activate).mockRejectedValue(new Error("startup failed"));
    vi.mocked(f.next.discard).mockRejectedValue(new Error("still alive"));
    await expect(f.coordinator.deploy("new", true)).rejects.toThrow("relinquish");
    expect(f.rollback.activate).not.toHaveBeenCalled();
  });
  it("leaves old routing intact when preparation fails", async () => {
    const f = fixture();
    f.prepare.mockRejectedValue(new Error("bad artifact"));
    await expect(f.coordinator.deploy("new", true)).rejects.toThrow("bad artifact");
    expect(f.old.retire).not.toHaveBeenCalled();
    expect(f.events).not.toContain("route:closed");
  });
  it("requires compatible state and serializes operations", async () => {
    const f = fixture();
    await expect(f.coordinator.deploy("new", false)).rejects.toThrow("compatibility");
    let resolve!: () => void;
    vi.mocked(f.old.retire).mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const pending = f.coordinator.deploy("new", true);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await expect(f.coordinator.deploy("new", true)).rejects.toThrow("in progress");
    resolve();
    await pending;
  });
});
