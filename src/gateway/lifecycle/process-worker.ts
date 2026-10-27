import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { ManagedWorker } from "./coordinator.js";
import {
  LifecycleResponseSchema,
  type LifecycleCommand,
  type LifecycleResponse,
} from "./protocol.js";

export class GatewayProcessWorker implements ManagedWorker {
  readonly id = randomUUID();
  private child?: ChildProcess;
  private exited = false;
  private readonly pending = new Map<
    string,
    {
      resolve: (reply: LifecycleResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly options: {
      releaseDir: string;
      port: number;
      timeoutMs: number;
      drainTimeoutMs: number;
      env?: NodeJS.ProcessEnv;
      onExit?: (workerId: string) => void;
    },
  ) {}

  private waitReply(id: string, timeoutMs: number): Promise<LifecycleResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker ${this.id} did not complete ${id} before its deadline`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async prepare(): Promise<void> {
    if (this.child) {
      throw new Error("Worker already spawned");
    }
    const releaseDir = await realpath(this.options.releaseDir);
    const entry = path.join(releaseDir, "dist", "gateway-worker.js");
    await access(entry);
    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      OPENCLAW_EXTERNAL_LIFECYCLE: "1",
      OPENCLAW_NO_RESPAWN: "1",
    };
    // An independently managed worker must not run old service-manager cleanup paths.
    delete env.OPENCLAW_SERVICE_MARKER;
    const ready = this.waitReply("prepared", this.options.timeoutMs);
    try {
      this.child = spawn(process.execPath, [entry, "--port", String(this.options.port)], {
        cwd: releaseDir,
        env,
        windowsHide: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      this.child.on("message", (message: unknown) => {
        const parsed = LifecycleResponseSchema.safeParse(message);
        if (!parsed.success) {
          return;
        }
        const pending = this.pending.get(parsed.data.id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(parsed.data.id);
        pending.resolve(parsed.data);
      });
      this.child.on("error", (error) => this.failPending(error));
      this.child.on("exit", () => {
        this.exited = true;
        this.failPending(new Error(`Worker ${this.id} exited`));
        this.options.onExit?.(this.id);
      });
      const response = await ready;
      if (!response.ok || response.state !== "prepared") {
        throw new Error("Worker preflight failed");
      }
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error(String(error)));
      await ready.catch(() => {});
      throw error;
    }
  }

  private async call(
    action: LifecycleCommand["action"],
    timeoutMs = this.options.timeoutMs,
  ): Promise<void> {
    if (!this.child?.connected || this.exited) {
      throw new Error("Worker IPC is unavailable");
    }
    const id = randomUUID();
    const reply = this.waitReply(id, timeoutMs + 5_000);
    this.child.send({ protocol: "openclaw-lifecycle-v1", id, action, timeoutMs }, (error) => {
      if (error) {
        this.failPending(error);
      }
    });
    const response = await reply;
    if (!response.ok) {
      throw new Error(response.error ?? `Worker ${action} failed`);
    }
  }

  activate(): Promise<void> {
    return this.call("activate");
  }
  quiesce(): Promise<void> {
    return this.call("quiesce", this.options.drainTimeoutMs);
  }
  resume(): Promise<void> {
    return this.call("resume");
  }
  deactivate(): Promise<void> {
    return this.call("deactivate");
  }
  hasExited(): boolean {
    return this.exited;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        reject(new Error(`Worker ${this.id} could not be retired; ownership remains uncertain`));
      }, 10_000);
      child.once("exit", onExit);
      // Only this externally owned process can retire a quiesced or failed worker.
      if (!child.kill("SIGKILL")) {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        reject(new Error(`Failed to terminate worker ${this.id}`));
      }
    });
  }
}
