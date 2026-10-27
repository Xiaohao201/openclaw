import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExternalLifecycleAllowed,
  isExternallyManagedGateway,
} from "./external-lifecycle.js";
import {
  emitGatewayRestart,
  scheduleGatewaySigusr1Restart,
  triggerOpenClawRestart,
} from "./restart.js";

afterEach(() => vi.unstubAllEnvs());

describe("external gateway lifecycle ownership", () => {
  it("leaves ordinary CLI administration available", () => {
    vi.stubEnv("OPENCLAW_EXTERNAL_LIFECYCLE", "");
    expect(isExternallyManagedGateway()).toBe(false);
    expect(() => assertExternalLifecycleAllowed("restart")).not.toThrow();
  });

  it("denies lifecycle operations inside a managed worker and its children", () => {
    vi.stubEnv("OPENCLAW_EXTERNAL_LIFECYCLE", "1");
    expect(isExternallyManagedGateway()).toBe(true);
    for (const operation of ["restart", "stop", "update", "install"]) {
      expect(() => assertExternalLifecycleAllowed(operation)).toThrow(/external service manager/);
    }
    expect(emitGatewayRestart()).toBe(false);
    expect(scheduleGatewaySigusr1Restart({ delayMs: 0 })).toMatchObject({
      ok: false,
      blockedBy: "external-lifecycle",
    });
    expect(triggerOpenClawRestart()).toMatchObject({ ok: false, method: "supervisor" });
  });
});
