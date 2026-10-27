import { describe, expect, it, vi } from "vitest";
import { DeploymentAdmission, drainDeployment } from "./deployment-drain.js";

describe("deployment drain", () => {
  it("closes admission before stopping producers and waits for queued and active work", async () => {
    const admission = new DeploymentAdmission();
    admission.active = 1;
    let pending = 2;
    const wait = vi.fn(async () => {
      pending = 0;
      admission.active = 0;
    });
    await drainDeployment({
      admission,
      pending: () => pending,
      wait,
      stopProducers: async () => {
        expect(admission.accepts("chat.send")).toBe(false);
        expect(admission.accepts("exec.approval.resolve")).toBe(true);
      },
    });
    expect(wait).toHaveBeenCalledOnce();
  });
  it("fails closed when a producer cannot stop", async () => {
    const admission = new DeploymentAdmission();
    await expect(
      drainDeployment({
        admission,
        pending: () => 0,
        stopProducers: async () => {
          throw new Error("consumer still owns work");
        },
      }),
    ).rejects.toThrow("consumer still owns work");
    expect(admission.draining).toBe(true);
  });
});
