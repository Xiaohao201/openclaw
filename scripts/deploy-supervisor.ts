import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { verifyDeployArtifact } from "./deploy-artifact.js";
import { startDeploymentControl } from "./deploy-control.js";
import { DeployCoordinator, type DeploymentPhase } from "./deploy-coordinator.js";
import { createDeployProxy } from "./deploy-proxy.js";
import { DeploymentEvents, RecoveryState, recoveryConfigSchema } from "./deploy-recovery-state.js";
import { ProcessWorker, deadline } from "./deploy-worker-process.js";

const portSchema = z.number().int().min(1024).max(65535);
const absolutePath = z.string().refine(path.isAbsolute, "An absolute path is required");
export const supervisorConfigSchema = z
  .object({
    host: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
    port: portSchema,
    slotPorts: z.tuple([portSchema, portSchema]),
    stateDir: absolutePath,
    configPath: absolutePath,
    initialRelease: absolutePath,
    journal: absolutePath,
    recovery: recoveryConfigSchema.prefault({}),
    startupTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  })
  .strict()
  .refine((c) => {
    const ports = [c.port, ...c.slotPorts];
    return ports.every((p, i) => ports.every((q, j) => i === j || Math.abs(p - q) >= 20));
  }, "Ingress and slot ports must be separated by at least 20");
const journalSchema = z.object({
  format: z.literal(1),
  phase: z.enum([
    "running",
    "preparing",
    "draining",
    "activating",
    "rolling-back",
    "blocked",
    "recovering",
  ]),
  release: absolutePath,
});
const deployCommandSchema = z
  .object({ release: absolutePath, compatibleState: z.literal(true) })
  .strict();

export async function runSupervisor(
  configFile: string,
  options: { input?: NodeJS.ReadableStream; installSignalHandlers?: boolean } = {},
) {
  const config = supervisorConfigSchema.parse(JSON.parse(await fs.readFile(configFile, "utf8")));
  const recovery = new RecoveryState(`${config.journal}.recovery.json`);
  const events = new DeploymentEvents(`${config.journal}.events.jsonl`);
  await recovery.load();
  let release = await fs.realpath(config.initialRelease);
  let interruptedRecovery = false;
  try {
    const journal = journalSchema.parse(JSON.parse(await fs.readFile(config.journal, "utf8")));
    if (journal.phase !== "running" && journal.phase !== "recovering") {
      throw new Error(
        `Interrupted deployment (${journal.phase}); inspect ownership and recover journal before restarting`,
      );
    }
    release = journal.release;
    interruptedRecovery = journal.phase === "recovering";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  type RuntimePhase = DeploymentPhase | "starting" | "stopping" | "stopped";
  let phase: RuntimePhase = "starting";
  const record = async (next: DeploymentPhase, current: string) => {
    const temporary = `${config.journal}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({ format: 1, phase: next, release: current }) + "\n",
    );
    await fs.rename(temporary, config.journal);
    phase = next;
    if (next === "running") {
      release = current;
    }
    await events.write(next, { release: current });
  };
  const proxy = createDeployProxy();
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(config.port, config.host, () => {
      proxy.server.off("error", reject);
      resolve();
    });
  });
  const workers = new Set<ProcessWorker>();
  let active: ProcessWorker | undefined;
  let coordinator: DeployCoordinator<ProcessWorker>;
  let shuttingDown = false;
  let busy = false;
  let operation: Promise<unknown> = Promise.resolve();
  let input: readline.Interface | undefined;
  let control: Awaited<ReturnType<typeof startDeploymentControl>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const cancellation = new AbortController();
  const status = () => ({
    phase,
    operationInProgress: busy,
    release,
    pid: active?.isExited ? null : (active?.pid ?? null),
    healthFailures: failures,
  });
  const block = async (reason: string) => {
    phase = "blocked";
    proxy.route(null);
    await recovery.block();
    await events.write("recovery-blocked", { reason, release });
  };
  const reportFailure = (error: unknown) => {
    // Loss of diagnostic/state persistence must not authorize another writer.
    phase = "blocked";
    proxy.route(null);
    console.error("[deploy] Lifecycle failure", error);
  };
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    if (shuttingDown) {
      return Promise.reject(new Error("Supervisor is stopping"));
    }
    if (busy) {
      return Promise.reject(new Error("Lifecycle operation already in progress"));
    }
    busy = true;
    const next = Promise.resolve()
      .then(fn)
      .finally(() => {
        busy = false;
      });
    operation = next;
    // Event-triggered operations must always have a rejection handler.
    void next.catch(() => {});
    return next;
  };
  const prepare = async (directory: string): Promise<ProcessWorker> => {
    const canonical = await fs.realpath(directory);
    await verifyDeployArtifact(canonical);
    await fs.access(path.join(canonical, "dist/deployment/worker.js"));
    const port = config.slotPorts.find((p) => p !== active?.port);
    if (!port) {
      throw new Error("No standby slot");
    }
    const worker = new ProcessWorker(
      port,
      canonical,
      config,
      async () => {
        // Persist ownership BEFORE activation can create any external side effects.
        await recovery.owners(
          [...workers].filter((w) => !w.isExited).flatMap((w) => (w.pid ? [w.pid] : [])),
        );
      },
      (exited, code, signal) => {
        workers.delete(exited);
        void events
          .write("worker-exit", { pid: exited.pid ?? null, code, signal })
          .catch(reportFailure);
        if (exited === active && !busy && !shuttingDown && phase === "running") {
          void exclusive(() => restore("worker-exit")).catch(reportFailure);
        }
      },
    );
    workers.add(worker);
    try {
      await worker.prepared(config.startupTimeoutMs);
      return worker;
    } catch (error) {
      await worker.discard();
      throw error;
    }
  };
  const makeCoordinator = () =>
    new DeployCoordinator({
      release,
      worker: active!,
      prepare,
      record,
      route: (worker) => {
        proxy.route(worker?.port ?? null);
        if (worker) {
          active = worker;
          failures = 0;
        }
      },
    });
  const restore = async (
    reason: "worker-exit" | "unhealthy" | "manual" | "interrupted" | "startup-failed",
  ) => {
    proxy.route(null);
    phase = "recovering";
    await events.write("recovery-start", { reason, release });
    await record("recovering", release);
    // A live or unresponsive owner is retired before ANY replacement is prepared.
    try {
      for (const worker of workers) {
        await worker.retire();
      }
      await recovery.owners([]);
    } catch {
      await block("owner-not-retired");
      return;
    }
    while (!cancellation.signal.aborted) {
      const waitMs = await recovery.attempt(config.recovery);
      if (waitMs === null) {
        await block("restart-budget-exhausted");
        return;
      }
      await events.write("recovery-backoff", { waitMs });
      try {
        await delay(waitMs, undefined, { signal: cancellation.signal });
      } catch {
        if (shuttingDown) {
          return;
        }
        throw new Error("Recovery delay interrupted");
      }
      if (shuttingDown) {
        return;
      }
      let candidate: ProcessWorker | undefined;
      try {
        candidate = await prepare(release);
        if (shuttingDown) {
          await candidate.discard();
          return;
        }
        await candidate.activate();
        if (candidate.isExited) {
          throw new Error("Worker exited during activation");
        }
        active = candidate;
        await record("running", release);
        coordinator = makeCoordinator();
        failures = 0;
        proxy.route(active.port);
        await events.write("recovery-complete", { pid: active.pid ?? null, release });
        // Retain only live workers; durable ownership is refreshed before activation.
        for (const worker of workers) {
          if (worker.isExited) {
            workers.delete(worker);
          }
        }
        return;
      } catch (error) {
        console.error("[deploy] Recovery attempt failed", error);
        try {
          await candidate?.discard();
          await recovery.owners([]);
        } catch {
          await block("candidate-not-retired");
          return;
        }
        await events.write("recovery-attempt-failed", { release });
      }
    }
  };
  const deploy = (directory: string, compatibleState: boolean) =>
    exclusive(async () => {
      if (phase !== "running") {
        throw new Error("Supervisor is not running; inspect recovery status");
      }
      return coordinator.deploy(await fs.realpath(directory), compatibleState);
    });
  const recover = () =>
    exclusive(async () => {
      if (phase !== "blocked") {
        throw new Error("Manual recovery is only allowed while blocked");
      }
      if ([...workers].some((w) => !w.isExited)) {
        throw new Error("A previous worker is still alive; inspect ownership first");
      }
      await recovery.reset();
      await restore("manual");
    });
  const monitor = async () => {
    try {
      const worker = active;
      if (!busy && !shuttingDown && phase === "running" && worker) {
        if (worker.isExited) {
          await exclusive(() => restore("worker-exit"));
        } else {
          let healthy = false;
          try {
            const response = await fetch(`http://127.0.0.1:${worker.port}/healthz`, {
              signal: AbortSignal.any([
                cancellation.signal,
                AbortSignal.timeout(config.recovery.healthTimeoutMs),
              ]),
              redirect: "error",
            });
            healthy = response.ok;
            await response.body?.cancel();
          } catch {
            /* Consecutive probe failures, not dependency errors, trigger retirement. */
          }
          // A deployment may have completed while the probe was in flight.
          if (!busy && !shuttingDown && phase === "running" && worker === active) {
            failures = healthy ? 0 : failures + 1;
            if (failures >= config.recovery.healthFailures) {
              await exclusive(() => restore("unhealthy"));
            }
          }
        }
      }
    } catch (error) {
      reportFailure(error);
    } finally {
      if (!shuttingDown) {
        timer = setTimeout(() => {
          void monitor();
        }, config.recovery.healthIntervalMs);
      }
    }
  };
  let closePromise: Promise<void> | undefined;
  const onSignal = () => {
    void shutdown().catch(reportFailure);
  };
  const shutdown = () => {
    closePromise ??= (async () => {
      shuttingDown = true;
      cancellation.abort();
      clearTimeout(timer);
      input?.close();
      await control?.close();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await operation.catch(() => {});
      phase = "stopping";
      proxy.route(null);
      try {
        for (const worker of workers) {
          await worker.retire();
        }
        await recovery.owners([]);
        phase = "stopped";
        await events.write("stopped");
      } finally {
        await proxy.close();
      }
    })();
    return closePromise;
  };
  try {
    if (recovery.blocked) {
      phase = "blocked";
      await events.write("recovery-blocked", { reason: "persisted-budget-or-ownership-block" });
    } else if (interruptedRecovery || recovery.unclean) {
      await exclusive(() => restore("interrupted"));
    } else {
      await exclusive(async () => {
        try {
          active = await prepare(release);
          await record("activating", release);
          await deadline(active.activate(), config.startupTimeoutMs);
          await record("running", release);
          coordinator = makeCoordinator();
          proxy.route(active.port);
        } catch (error) {
          console.error("[deploy] Initial startup failed", error);
          await restore("startup-failed");
        }
      });
    }
    control = await startDeploymentControl(`${config.journal}.commands`, async (command) => {
      switch (command.command) {
        case "status":
          return status();
        case "deploy":
          return deploy(command.release, command.compatibleState);
        case "recover":
          await recover();
          return status();
        case "stop":
          // Finish the response before closing the control channel itself.
          setImmediate(() => {
            void shutdown().catch(reportFailure);
          });
          return { accepted: true };
        default:
          throw new Error("Unsupported deployment command");
      }
    });
    input = readline.createInterface({ input: options.input ?? process.stdin });
    input.on("line", (line) => {
      if (shuttingDown || !line.trim()) {
        return;
      }
      try {
        const command = deployCommandSchema.parse(JSON.parse(line));
        void deploy(command.release, command.compatibleState).catch(console.error);
      } catch (error) {
        console.error(error);
      }
    });
    if (options.installSignalHandlers !== false) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }
    timer = setTimeout(() => {
      void monitor();
    }, config.recovery.healthIntervalMs);
    await events.write("supervisor-ready", { phase });
    return { deploy, recover, status, close: shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = process.argv[2];
  if (!config) {
    throw new Error("Usage: pnpm deploy:serve <supervisor-config.json>");
  }
  await runSupervisor(config);
}
