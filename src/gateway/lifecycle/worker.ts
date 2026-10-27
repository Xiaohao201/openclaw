import type { LifecycleCommand, LifecycleResponse } from "./protocol.js";

export type WorkerRuntime = {
  activate: (timeoutMs: number) => Promise<void>;
  quiesce: (timeoutMs: number) => Promise<void>;
  resume: () => Promise<void>;
  deactivate: () => Promise<void>;
};

/** IPC requests are serialized. There is intentionally no exit, restart, or arbitrary command verb. */
export class GatewayLifecycleWorker {
  private state: LifecycleResponse["state"] = "prepared";
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly runtime: WorkerRuntime) {}

  handle(command: LifecycleCommand): Promise<LifecycleResponse> {
    const result = this.pending.then(() => this.execute(command));
    this.pending = result.catch(() => {});
    return result;
  }

  private async execute(command: LifecycleCommand): Promise<LifecycleResponse> {
    try {
      switch (command.action) {
        case "activate":
          if (this.state !== "prepared") {
            throw new Error("Worker is not prepared");
          }
          this.state = "failed";
          await this.runtime.activate(command.timeoutMs);
          this.state = "quiesced";
          break;
        case "quiesce":
          if (this.state !== "active") {
            throw new Error("Worker is not active");
          }
          // A failed pause can be partially applied; resume remains available.
          this.state = "pausing";
          await this.runtime.quiesce(command.timeoutMs);
          this.state = "quiesced";
          break;
        case "resume":
          if (this.state === "active") {
            break;
          }
          if (this.state !== "quiesced" && this.state !== "pausing") {
            throw new Error("Worker is not paused");
          }
          await this.runtime.resume();
          this.state = "active";
          break;
        case "deactivate":
          if (this.state !== "quiesced") {
            throw new Error("Only a quiesced worker can deactivate");
          }
          this.state = "failed";
          await this.runtime.deactivate();
          this.state = "prepared";
          break;
        case "status":
          break;
      }
      return { protocol: command.protocol, id: command.id, ok: true, state: this.state };
    } catch (error) {
      return {
        protocol: command.protocol,
        id: command.id,
        ok: false,
        state: this.state,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
