import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../plugin-sdk/extension-shared.js";
import { drainManagedGateway } from "./drain.js";

describe("managed gateway drain", () => {
  it("does not reset the budget after a slow ingress pause", async () => {
    const execution = vi.fn();
    await expect(
      drainManagedGateway({
        timeoutMs: 5,
        pauseIngress: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        isIdle: () => true,
        closeAdmission: vi.fn(),
        pauseExecution: execution,
      }),
    ).rejects.toThrow("deadline");
    expect(execution).not.toHaveBeenCalled();
  });
  it("allows accepted task continuations before closing execution admission", async () => {
    const events: string[] = [];
    const release = createDeferred<void>();
    let idle = false;
    const execution = vi.fn(async () => {
      events.push("execution");
    });
    const draining = drainManagedGateway({
      timeoutMs: 1000,
      pauseIngress: async () => {
        events.push("ingress");
        await release.promise;
        idle = true;
      },
      isIdle: () => idle,
      closeAdmission: () => {
        events.push("admission");
      },
      pauseExecution: execution,
    });
    expect(execution).not.toHaveBeenCalled();
    events.push("accepted continuation finished");
    release.resolve(undefined);
    await draining;
    expect(events).toEqual(["ingress", "accepted continuation finished", "admission", "execution"]);
  });
  it("does not close execution admission when active work exceeds the deadline", async () => {
    const execution = vi.fn();
    await expect(
      drainManagedGateway({
        timeoutMs: 5,
        pauseIngress: async () => {},
        isIdle: () => false,
        closeAdmission: vi.fn(),
        pauseExecution: execution,
      }),
    ).rejects.toThrow("active work");
    expect(execution).not.toHaveBeenCalled();
  });
  it("rejects work racing with final admission closure", async () => {
    let idle = true;
    const execution = vi.fn();
    await expect(
      drainManagedGateway({
        timeoutMs: 100,
        pauseIngress: async () => {},
        isIdle: () => idle,
        closeAdmission: () => {
          idle = false;
        },
        pauseExecution: execution,
      }),
    ).rejects.toThrow("closing admission");
    expect(execution).not.toHaveBeenCalled();
  });
});
