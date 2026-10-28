import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserServiceWork,
  createBrowserControlHandoff,
  isBrowserControlManaged,
  markBrowserControlInitialized,
  markBrowserControlStopped,
} from "./service-handoff.js";

describe("browser control handoff", () => {
  it("rejects older hosts and cannot resume before initialization", async () => {
    expect(() =>
      createBrowserControlHandoff({
        config: {},
        stateDir: "test",
        logger: console,
        lifecycleMode: "externally-managed",
      }),
    ).toThrow("handoff v2");
    const ctx = { config: {}, stateDir: "test", logger: console, handoffVersion: 2 as const };
    const handoff = createBrowserControlHandoff(ctx);
    await expect(handoff.resume(ctx)).rejects.toThrow("not initialized");
  });
  afterEach(() => {
    browserServiceWork.resume();
  });
  it("rejects standby operations and waits beyond caller timeout for actual completion", async () => {
    const ctx = {
      config: {},
      stateDir: "test",
      logger: console,
      lifecycleMode: "externally-managed" as const,
      handoffVersion: 2 as const,
    };
    const handoff = createBrowserControlHandoff(ctx);
    expect(handoff.isReady(ctx)).toBe(false);
    await expect(browserServiceWork.run(async () => {})).rejects.toThrow("not accepting");
    markBrowserControlInitialized();
    expect(handoff.isReady(ctx)).toBe(true);
    expect(isBrowserControlManaged()).toBe(true);
    await handoff.resume(ctx);
    const operation = createDeferred<void>();
    const running = browserServiceWork.run(() => operation.promise);
    await expect(handoff.pause(ctx, 5)).rejects.toThrow("active");
    operation.resolve(undefined);
    await running;
    await handoff.pause(ctx, 100);
    markBrowserControlStopped();
    expect(handoff.isReady(ctx)).toBe(false);
  });
});
