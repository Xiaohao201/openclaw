import { appendFile, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { assertExternalLifecycleAllowed } from "../../infra/external-lifecycle.js";
import { GatewayLifecycleCoordinator } from "./coordinator.js";
import { GatewayProcessWorker } from "./process-worker.js";

const CommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("replace"), release: z.string().min(1) }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
]);

const OptionsSchema = z.object({
  release: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  timeout: z.coerce.number().int().min(1000).max(3_600_000),
  drainTimeout: z.coerce.number().int().min(1000).max(3_600_000),
});

/** Local operator stdin is the management interface. Workers receive neither it nor management credentials. */
export async function runGatewayManager(rawOptions: unknown): Promise<void> {
  assertExternalLifecycleAllowed("manage services");
  const options = OptionsSchema.parse(rawOptions);
  const stateDir = path.join(resolveStateDir(), "lifecycle");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Do not reclaim an uncertain manager lock automatically: the old worker may still own the queue.
  const lockPath = path.join(stateDir, "manager.lock");
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const manager = new GatewayLifecycleCoordinator();
  let release = path.resolve(options.release);
  let commandRunning = false;
  let recoveryAttempts = 0;
  let recoveryAt = 0;
  let stopping = false;
  let crashedWorker: string | undefined;
  const record = async (event: string, error?: unknown) => {
    const entry = {
      time: new Date().toISOString(),
      event,
      ...manager.snapshot(),
      ...(error ? { error: formatErrorMessage(error) } : {}),
    };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    await appendFile(path.join(stateDir, "events.jsonl"), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  };
  const createWorker = (releaseDir: string) =>
    new GatewayProcessWorker({
      releaseDir,
      port: options.port,
      timeoutMs: options.timeout,
      drainTimeoutMs: options.drainTimeout,
      onExit: (id) => {
        if (manager.snapshot().workerId === id && !stopping) {
          crashedWorker = id;
        }
      },
    });
  let input: ReturnType<typeof createInterface> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  try {
    try {
      await manager.start(createWorker(release));
    } catch (error) {
      if (manager.snapshot().phase !== "active") {
        throw error;
      }
      await record("admission-needs-attention", error);
    }
    await record("started");
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const completed = new Promise<void>((resolve) => {
      input!.on("line", (line) => {
        void (async () => {
          if (line.length > 16_384) {
            throw new Error("Management command is too large");
          }
          const command = CommandSchema.parse(JSON.parse(line));
          if (command.action === "status") {
            await record("status");
            return;
          }
          if (commandRunning) {
            throw new Error("A management operation is already in progress");
          }
          commandRunning = true;
          try {
            if (command.action === "replace") {
              const nextRelease = path.resolve(command.release);
              await record("replacement-requested");
              const candidate = createWorker(nextRelease);
              try {
                await manager.replace(candidate);
              } finally {
                if (manager.snapshot().workerId === candidate.id) {
                  release = nextRelease;
                }
              }
              recoveryAttempts = 0;
              await record("replacement-completed");
            } else if (command.action === "resume") {
              await manager.resume();
              await record("resumed");
            } else {
              stopping = true;
              try {
                await manager.stop();
              } catch (error) {
                stopping = false;
                throw error;
              }
              await record("stopped");
              resolve();
            }
          } finally {
            commandRunning = false;
          }
        })().catch((error) => {
          void record("operation-failed", error).catch(() => {});
        });
      });
      input!.on("close", () => {
        if (!stopping) {
          void record("operator-input-closed; service remains running").catch(() => {});
        }
      });
    });
    recoveryTimer = setInterval(() => {
      if (!crashedWorker || commandRunning || stopping || Date.now() < recoveryAt) {
        return;
      }
      if (recoveryAttempts >= 3) {
        return;
      }
      commandRunning = true;
      recoveryAttempts += 1;
      void (async () => {
        await record("crash-recovery-started");
        if (manager.snapshot().phase === "empty") {
          await manager.start(createWorker(release));
        } else {
          await manager.recover(createWorker(release));
        }
        crashedWorker = undefined;
        await record("crash-recovery-completed");
      })()
        .catch(async (error) => {
          recoveryAt = Date.now() + recoveryAttempts * 5_000;
          await record(
            recoveryAttempts >= 3 ? "crash-recovery-exhausted" : "crash-recovery-failed",
            error,
          );
        })
        .finally(() => {
          commandRunning = false;
        });
    }, 1000);
    const onSignal = () => {
      process.stderr.write(
        'Use the external manager command {"action":"stop"} for a drained shutdown.\n',
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      await completed;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } finally {
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
    }
    input?.close();
    await lock.close();
    if (manager.snapshot().phase === "empty") {
      await unlink(lockPath);
    }
  }
}
