import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayLifecycleCoordinator } from "./coordinator.js";
import { GatewayProcessWorker } from "./process-worker.js";

const workers: GatewayProcessWorker[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.dispose()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function release(failActivation = false): Promise<GatewayProcessWorker> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-test-"));
  directories.push(dir);
  await mkdir(path.join(dir, "dist"));
  await writeFile(
    path.join(dir, "dist", "gateway-worker.js"),
    `
    if (!process.send || process.env.OPENCLAW_EXTERNAL_LIFECYCLE !== '1') process.exit(2);
    let state = 'prepared';
    process.on('message', ({protocol, id, action}) => {
      if (${JSON.stringify(failActivation)} && action === 'activate') {
        process.send({protocol, id, ok: false, state: 'failed', error: 'candidate startup failed'});
        return;
      }
      if (action === 'activate' || action === 'quiesce') state = 'quiesced';
      if (action === 'resume') state = 'active';
      if (action === 'deactivate') state = 'prepared';
      process.send({protocol, id, ok: true, state});
    });
    process.send({protocol: 'openclaw-lifecycle-v1', id: 'prepared', ok: true, state});
    setInterval(() => {}, 1000);
  `,
  );
  const worker = new GatewayProcessWorker({
    releaseDir: dir,
    port: 18789,
    timeoutMs: 5000,
    drainTimeoutMs: 5000,
  });
  workers.push(worker);
  return worker;
}

describe("external manager with real child processes", () => {
  it("rejects operations without a live private transport or duplicate spawning", async () => {
    const worker = await release();
    await expect(worker.activate()).rejects.toThrow("IPC is unavailable");
    await worker.dispose();
    await worker.prepare();
    await expect(worker.prepare()).rejects.toThrow("already spawned");
    await worker.dispose();
    await worker.dispose();
    await expect(worker.resume()).rejects.toThrow("IPC is unavailable");
  });

  it("replaces a process and confirms the old PID exited", async () => {
    const old = await release();
    const next = await release();
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await manager.replace(next);
    expect(old.hasExited()).toBe(true);
    expect(next.hasExited()).toBe(false);
    expect(manager.snapshot().workerId).toBe(next.id);
    await manager.stop();
    expect(next.hasExited()).toBe(true);
  });

  it("restores the previous process when candidate activation fails", async () => {
    const old = await release();
    const next = await release(true);
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.replace(next)).rejects.toThrow("candidate startup failed");
    expect(next.hasExited()).toBe(true);
    expect(old.hasExited()).toBe(false);
    expect(manager.snapshot()).toEqual({ phase: "active", workerId: old.id });
    await manager.stop();
  });

  it("recovers only after confirmed process death", async () => {
    const old = await release();
    const next = await release();
    const manager = new GatewayLifecycleCoordinator();
    await manager.start(old);
    await expect(manager.recover(next)).rejects.toThrow("confirmed process exit");
    await old.dispose();
    await manager.recover(next);
    expect(manager.snapshot().workerId).toBe(next.id);
    await manager.stop();
  });
});
