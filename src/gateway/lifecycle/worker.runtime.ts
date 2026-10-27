import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getActiveEmbeddedRunCount } from "../../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../../auto-reply/reply/dispatcher-registry.js";
import { loadConfig } from "../../config/config.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../../infra/gateway-lock.js";
import {
  getTotalQueueSize,
  markGatewayDraining,
  resetAllLanes,
  resumeGatewayAdmission,
} from "../../process/command-queue.js";
import { prepareSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { getInspectableTaskRegistrySummary } from "../../tasks/task-registry.maintenance.js";
import type { GatewayServer } from "../server.js";
import { LifecycleCommandSchema } from "./protocol.js";
import { GatewayLifecycleWorker } from "./worker.js";

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Lifecycle deadline exceeded; active work was not aborted");
    }
    await delay(100);
  }
}

export async function runManagedGatewayWorker(params: {
  start: (opts?: { startupStartedAt?: number }) => Promise<GatewayServer>;
  lockPort?: number;
}): Promise<never> {
  if (!process.send || !process.connected) {
    throw new Error("A managed gateway requires a private IPC connection to its external manager");
  }
  if (process.env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1") {
    throw new Error("Managed handoff requires exclusive Gateway locking");
  }
  // Preload the same implementation that server.ts loads, without starting channels or services.
  await import("../server.impl.js");
  // Resolve the cold config/provider graph before asking the old worker to release ownership.
  // Preparing a snapshot does not activate it or start services; activation still rereads config.
  process.stderr.write("[lifecycle] preflighting runtime configuration\n");
  const config = loadConfig();
  const statePaths = [
    config.agents?.defaults?.workspace,
    config.session?.store,
    ...(config.agents?.list ?? []).flatMap((agent) => [agent.workspace, agent.agentDir]),
  ];
  if (statePaths.some((value) => value && !path.isAbsolute(value) && !value.startsWith("~/"))) {
    throw new Error("Managed handoff requires absolute workspace, agent, and session store paths");
  }
  await prepareSecretsRuntimeSnapshot({ config });
  let server: GatewayServer | undefined;
  let lock: GatewayLockHandle | null = null;
  const idle = () =>
    getTotalQueueSize() === 0 &&
    getActiveEmbeddedRunCount() === 0 &&
    getTotalPendingReplies() === 0 &&
    getInspectableTaskRegistrySummary().active === 0;
  const worker = new GatewayLifecycleWorker({
    activate: async (timeoutMs) => {
      if (server || lock) {
        throw new Error("Previous server has not fully released ownership");
      }
      lock = await acquireGatewayLock({ port: params.lockPort, allowInTests: true });
      if (!lock) {
        throw new Error("Exclusive Gateway lock unavailable");
      }
      process.stderr.write("[lifecycle] ownership acquired; starting server in standby\n");
      resetAllLanes();
      markGatewayDraining();
      server = await params.start({ startupStartedAt: Date.now() });
      process.stderr.write("[lifecycle] server started; checking dependencies\n");
      if (!server.handoff) {
        throw new Error("Server does not support managed handoff");
      }
      await waitUntil(() => server?.handoff?.isReady() === true, timeoutMs);
    },
    quiesce: async (timeoutMs) => {
      if (!server?.handoff) {
        throw new Error("No managed server is active");
      }
      const deadline = Date.now() + timeoutMs;
      await server.handoff.pause(timeoutMs);
      // Plugin ingress is paused first, so accepted RabbitMQ handlers can finish all nested work.
      await waitUntil(idle, Math.max(1, deadline - Date.now()));
      markGatewayDraining();
      if (!idle()) {
        throw new Error("New work arrived while closing admission");
      }
    },
    resume: async () => {
      resumeGatewayAdmission();
      await server?.handoff?.resume();
    },
    deactivate: async () => {
      if (!idle()) {
        throw new Error("Cannot deactivate a worker with pending work");
      }
      await server?.close({ reason: "external manager handoff", restartExpectedMs: null });
      server = undefined;
      await lock?.release();
      lock = null;
    },
  });
  process.on("message", (message: unknown) => {
    const parsed = LifecycleCommandSchema.safeParse(message);
    if (!parsed.success) {
      process.stderr.write("[lifecycle] rejected invalid management message\n");
      return;
    }
    process.stderr.write(`[lifecycle] ${parsed.data.action} requested\n`);
    void worker.handle(parsed.data).then((reply) => {
      process.stderr.write(
        `[lifecycle] ${parsed.data.action}: ${reply.ok ? reply.state : "failed"}\n`,
      );
      if (process.connected) {
        process.send?.(reply, () => {});
      }
    });
  });
  const ignoreSignal = () => {
    process.stderr.write(
      "Managed gateway lifecycle belongs to the external manager; signal ignored.\n",
    );
  };
  process.on("SIGUSR1", ignoreSignal);
  process.on("SIGINT", ignoreSignal);
  process.on("SIGTERM", ignoreSignal);
  process.on("disconnect", () => {
    process.stderr.write(
      "External manager disconnected; keeping the worker alive. Operator recovery is required.\n",
    );
  });
  process.send({ protocol: "openclaw-lifecycle-v1", id: "prepared", ok: true, state: "prepared" });
  // Keep standby workers alive even after manager loss. Only the manager can retire a process.
  setInterval(() => {}, 60_000);
  return await new Promise<never>(() => {});
}
