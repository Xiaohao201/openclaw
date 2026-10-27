import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config/config.js";
import type { GatewayServer } from "../gateway/server.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";

const commandSchema = z.object({ command: z.enum(["activate", "retire"]), id: z.number().int() });

async function main() {
  if (
    !process.send ||
    !process.env.OPENCLAW_CONFIG_PATH ||
    !process.env.OPENCLAW_STATE_DIR ||
    process.env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1"
  ) {
    throw new Error(
      "Managed worker requires IPC, explicit shared state/config and exclusive Gateway locking",
    );
  }
  const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.OPENCLAW_DEPLOY_PORT);
  // Load code while standby, but do not start the Gateway, consumers or timers.
  const { startGatewayServer } = await import("../gateway/server.js");
  let server: GatewayServer | undefined;
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  let activated = false;
  let chain = Promise.resolve();
  const retire = async () => {
    if (server) {
      if (!server.drainForDeployment) {
        throw new Error("Gateway does not support deployment drain");
      }
      await server.drainForDeployment();
      await server.close({ reason: "deployment", restartExpectedMs: 1000 });
    }
    await lock?.release();
    process.exit(0);
  };
  process.on("message", (raw) => {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const { command, id } = parsed.data;
    chain = chain.then(async () => {
      try {
        if (command === "retire") {
          await retire();
          return;
        }
        if (activated) {
          throw new Error("Worker already activated");
        }
        activated = true;
        lock = await acquireGatewayLock({ port, allowInTests: true });
        if (!lock) {
          throw new Error("Exclusive execution lock unavailable");
        }
        const config = loadConfig();
        const statePaths = [
          config.agents?.defaults?.workspace,
          config.session?.store,
          ...(config.agents?.list ?? []).flatMap((agent) => [agent.workspace, agent.agentDir]),
        ];
        if (
          statePaths.some((value) => value && !path.isAbsolute(value) && !value.startsWith("~/"))
        ) {
          throw new Error(
            "Managed deployment requires absolute workspace, agent and session store paths",
          );
        }
        if (
          !config.gateway?.trustedProxies?.includes("127.0.0.1") ||
          !["token", "password"].includes(config.gateway?.auth?.mode ?? "") ||
          config.gateway?.tls?.enabled
        ) {
          throw new Error(
            "Managed ingress requires trustedProxies 127.0.0.1, explicit token/password auth, and plain HTTP backend",
          );
        }
        server = await startGatewayServer(port, { bind: "loopback", host: "127.0.0.1" });
        server.checkDeploymentReady?.();
        process.send?.({ id, ok: true });
      } catch (error) {
        // Stay alive and retain ownership until the parent explicitly retires
        // us. The parent must observe exit before it attempts rollback.
        process.send?.({
          id,
          ok: false,
          error: error instanceof Error ? error.message : "Worker command failed",
        });
      }
    });
  });
  process.on("disconnect", () => {
    chain = chain.then(retire).catch((error) => {
      console.error(error);
    });
  });
  process.on("SIGTERM", () => {
    chain = chain.then(retire).catch((error) => {
      console.error(error);
    });
  });
  process.on("SIGINT", () => {
    chain = chain.then(retire).catch((error) => {
      console.error(error);
    });
  });
  process.send({ ready: true });
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
