import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { verifyDeployArtifact } from "./deploy-artifact.js";
import {
  DeployCoordinator,
  type DeployWorker,
  type DeploymentPhase,
} from "./deploy-coordinator.js";
import { createDeployProxy } from "./deploy-proxy.js";

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
    startupTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  })
  .strict()
  .refine((c) => {
    const ports = [c.port, ...c.slotPorts];
    return ports.every((p, i) => ports.every((q, j) => i === j || Math.abs(p - q) >= 20));
  }, "Ingress and slot ports must be separated by at least 20");
const replySchema = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number().int(), ok: z.boolean(), error: z.string().optional() }),
]);
const journalSchema = z.object({
  format: z.literal(1),
  phase: z.enum(["running", "preparing", "draining", "activating", "rolling-back", "blocked"]),
  release: absolutePath,
});
const deployCommandSchema = z
  .object({ release: absolutePath, compatibleState: z.literal(true) })
  .strict();

class ProcessWorker implements DeployWorker {
  private sequence = 0;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private child: ChildProcess;
  private exited = false;
  private exitPromise: Promise<void>;
  private readyPromise: Promise<void>;
  private activated = false;
  constructor(
    readonly port: number,
    release: string,
    private config: z.infer<typeof supervisorConfigSchema>,
  ) {
    const forkOptions: ForkOptions & { windowsHide: boolean } = {
      cwd: release,
      windowsHide: true,
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        OPENCLAW_ALLOW_MULTI_GATEWAY: "0",
        OPENCLAW_MANAGED_DEPLOYMENT: "1",
        OPENCLAW_STATE_DIR: config.stateDir,
        OPENCLAW_CONFIG_PATH: config.configPath,
        OPENCLAW_DEPLOY_PORT: String(port),
        OPENCLAW_GATEWAY_PORT: String(port),
      },
    };
    this.child = fork(path.join(release, "dist/deployment/worker.js"), [], forkOptions);
    let ready!: () => void, failReady!: (error: Error) => void;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failReady = reject;
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once("exit", () => {
        this.exited = true;
        const error = new Error("Deployment worker exited");
        failReady(error);
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
        resolve();
      });
      this.child.once("error", (error) => {
        failReady(error);
        if (!this.child.pid) {
          this.exited = true;
          resolve();
        }
      });
    });
    this.child.on("message", (raw) => {
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success) {
        return;
      }
      const reply = parsed.data;
      if ("ready" in reply) {
        ready();
        return;
      }
      const pending = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      if (reply.ok) {
        pending?.resolve();
      } else {
        pending?.reject(new Error(reply.error ?? "Worker command failed"));
      }
    });
  }
  async prepared(timeoutMs: number) {
    await deadline(this.readyPromise, timeoutMs);
  }
  private command(command: "activate" | "retire") {
    if (this.exited) {
      return Promise.reject(new Error("Worker already exited"));
    }
    const id = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ command, id }, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  activate() {
    this.activated = true;
    return deadline(this.command("activate"), this.config.startupTimeoutMs);
  }
  async retire() {
    if (this.exited) {
      return;
    }
    // Successful retirement exits instead of replying. A negative reply must
    // fail closed; no force-kill timeout grants another process execution.
    const command = this.command("retire");
    await Promise.race([
      this.exitPromise,
      command.catch((error: unknown) => {
        if (!this.exited) {
          throw error;
        }
      }),
    ]);
    await this.exitPromise;
  }
  async discard() {
    if (!this.activated && !this.exited) {
      this.child.kill();
      await this.exitPromise;
      return;
    }
    await this.retire();
  }
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Worker startup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSupervisor(
  configFile: string,
  options: {
    input?: NodeJS.ReadableStream;
    installSignalHandlers?: boolean;
  } = {},
) {
  const config = supervisorConfigSchema.parse(JSON.parse(await fs.readFile(configFile, "utf8")));
  let release = config.initialRelease;
  try {
    const journal = journalSchema.parse(JSON.parse(await fs.readFile(config.journal, "utf8")));
    if (journal.phase !== "running") {
      throw new Error(
        `Interrupted deployment (${journal.phase}); inspect ownership and recover journal before restarting`,
      );
    }
    release = journal.release;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const record = async (phase: DeploymentPhase, current: string) => {
    const temporary = `${config.journal}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ format: 1, phase, release: current }) + "\n", {
      flag: "wx",
    });
    await fs.rename(temporary, config.journal);
    console.log(`[deploy] ${phase}`);
  };
  const proxy = createDeployProxy();
  // Bind the stable port before starting any business process. A duplicate
  // supervisor fails here without contacting RabbitMQ or MySQL.
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(config.port, config.host, () => {
      proxy.server.off("error", reject);
      resolve();
    });
  });
  const workers = new Set<ProcessWorker>();
  let active: ProcessWorker | undefined;
  const prepare = async (directory: string): Promise<ProcessWorker> => {
    const canonical = await fs.realpath(directory);
    await verifyDeployArtifact(canonical);
    await fs.access(path.join(canonical, "dist/deployment/worker.js"));
    const port = config.slotPorts.find((p) => p !== active?.port);
    if (!port) {
      throw new Error("No standby slot");
    }
    const worker = new ProcessWorker(port, canonical, config);
    workers.add(worker);
    try {
      await worker.prepared(config.startupTimeoutMs);
      return worker;
    } catch (error) {
      await worker.discard();
      throw error;
    }
  };
  let shuttingDown = false;
  let operation: Promise<unknown> = Promise.resolve();
  let input: readline.Interface | undefined;
  const onSignal = () => {
    void shutdown().catch(console.error);
  };
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    input?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await operation.catch(() => {});
    proxy.route(null);
    for (const worker of workers) {
      await worker.retire();
    }
    await proxy.close();
  };
  try {
    active = await prepare(release);
    await record("activating", release);
    await deadline(active.activate(), config.startupTimeoutMs);
    await record("running", release);
    proxy.route(active.port);
    const coordinator = new DeployCoordinator({
      release,
      worker: active,
      prepare,
      record,
      route: (worker) => {
        const port = worker?.port ?? null;
        proxy.route(port);
        if (port !== null) {
          active = [...workers].findLast((w) => w.port === port);
        }
      },
    });
    const deploy = (directory: string, compatibleState: boolean) => {
      if (shuttingDown) {
        return Promise.reject(new Error("Supervisor is stopping"));
      }
      const next = coordinator.deploy(directory, compatibleState);
      operation = Promise.allSettled([operation, next]);
      return next;
    };
    input = readline.createInterface({ input: options.input ?? process.stdin });
    input.on("line", (line) => {
      if (shuttingDown || !line.trim()) {
        return;
      }
      try {
        const command = deployCommandSchema.parse(JSON.parse(line));
        void deploy(command.release, command.compatibleState)
          .then((result) => console.log(`[deploy] ${result}`))
          .catch((error) => console.error(error));
      } catch (error) {
        console.error(error);
      }
    });
    if (options.installSignalHandlers !== false) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }
    console.log(
      '[deploy] Ready. Enter {"release":"ABSOLUTE_PATH","compatibleState":true} to deploy.',
    );
    return { deploy, close: shutdown };
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
