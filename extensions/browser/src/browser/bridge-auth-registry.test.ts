import { afterEach, expect, it, vi } from "vitest";
import * as initialRegistry from "./bridge-auth-registry.js";

const port = 43123;
afterEach(() => initialRegistry.deleteBridgeAuthForPort(port));

it("shares and removes private bridge credentials across independent module instances", async () => {
  initialRegistry.setBridgeAuthForPort(port, { token: "test-only-private-bridge" });
  // The gateway loads a plugin through jiti while its lazy runtime uses native ESM.
  // Reset once to model those independent instances of this small registry module.
  vi.resetModules();
  const anotherRegistry = await import("./bridge-auth-registry.js");
  try {
    expect(anotherRegistry.getBridgeAuthForPort(port)).toEqual({
      token: "test-only-private-bridge",
      password: undefined,
    });
    anotherRegistry.deleteBridgeAuthForPort(port);
    expect(initialRegistry.getBridgeAuthForPort(port)).toBeUndefined();
  } finally {
    anotherRegistry.deleteBridgeAuthForPort(port);
  }
});
