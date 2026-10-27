import { mkdtemp, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { GatewayLifecycleCoordinator } from "./coordinator.js";
import { GatewayProcessWorker } from "./process-worker.js";

// Explicit opt-in: exercises built artifacts in fresh processes, never the user's config or broker.
it.runIf(process.env.OPENCLAW_LIFECYCLE_SMOKE === "1")(
  "hands off a built Gateway on an isolated port",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-managed-smoke-"));
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("No ephemeral port");
    }
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const configPath = path.join(dir, "openclaw.json");
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: "lifecycle-smoke-test-only" },
          controlUi: { enabled: false },
          reload: { mode: "off" },
        },
        plugins: { enabled: false },
        canvasHost: { enabled: false },
        update: { checkOnStart: false },
        hooks: { internal: { enabled: false } },
      }),
    );
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_ALLOW_MULTI_GATEWAY: "0",
    };
    const old = new GatewayProcessWorker({
      releaseDir: process.cwd(),
      port,
      timeoutMs: 120_000,
      drainTimeoutMs: 5000,
      env,
    });
    const next = new GatewayProcessWorker({
      releaseDir: process.cwd(),
      port,
      timeoutMs: 120_000,
      drainTimeoutMs: 5000,
      env,
    });
    const manager = new GatewayLifecycleCoordinator();
    let pauseStartedAt = 0;
    const quiesce = old.quiesce.bind(old);
    vi.spyOn(old, "quiesce").mockImplementation(async () => {
      pauseStartedAt = Date.now();
      return quiesce();
    });
    try {
      await manager.start(old);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
      await expect(
        acquireGatewayLock({ env, port, allowInTests: true, timeoutMs: 150, pollIntervalMs: 25 }),
      ).rejects.toThrow("gateway already running");
      await manager.replace(next);
      console.info(`Managed Gateway handoff pause: ${Date.now() - pauseStartedAt}ms`);
      expect(old.hasExited()).toBe(true);
      expect(next.hasExited()).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
      await manager.stop();
    } finally {
      await Promise.all([old.dispose(), next.dispose()]);
      await rm(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
