import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { DeployWorker } from "./deploy-coordinator.js";

type WorkerConfig = {
  stateDir: string;
  configPath: string;
  startupTimeoutMs: number;
  recovery: { retireTimeoutMs: number };
};
const replySchema = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number().int(), ok: z.boolean(), error: z.string().optional() }),
]);

export class ProcessWorker implements DeployWorker {
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
    private config: WorkerConfig,
    private beforeActivate: () => Promise<void>,
    private onExit: (worker: ProcessWorker, code: number | null, signal: string | null) => void,
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
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        const error = new Error("Deployment worker exited");
        failReady(error);
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
        resolve();
        this.onExit(this, code, signal);
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
  get pid() {
    return this.child.pid;
  }
  get isExited() {
    return this.exited;
  }
  async activate() {
    await this.beforeActivate();
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
    await deadline(
      Promise.race([
        this.exitPromise,
        command.catch((error: unknown) => {
          if (!this.exited) {
            throw error;
          }
        }),
      ]),
      this.config.recovery.retireTimeoutMs,
    );
    await deadline(this.exitPromise, this.config.recovery.retireTimeoutMs);
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

export async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Worker operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
