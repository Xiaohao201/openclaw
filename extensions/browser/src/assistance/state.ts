export type AssistanceOutcome = "resumed" | "cancelled" | "expired" | "unavailable";
export type AssistanceStatus = "waiting" | "verifying" | AssistanceOutcome;

/** A single-use, bounded wait. Cancellation always wins over an in-flight check. */
export class AssistanceRequest {
  status: AssistanceStatus = "waiting";
  readonly expiresAt: number;
  readonly done: Promise<AssistanceOutcome>;
  private settle!: (outcome: AssistanceOutcome) => void;
  private timer: ReturnType<typeof setTimeout>;
  private checking?: Promise<boolean>;
  private readonly abort = () => this.cancel();

  constructor(
    private readonly options: {
      timeoutMs: number;
      signal?: AbortSignal;
      verify: () => Promise<boolean>;
    },
  ) {
    this.expiresAt = Date.now() + options.timeoutMs;
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.timer = setTimeout(() => this.finish("expired"), options.timeoutMs);
    this.timer.unref?.();
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) {
      this.cancel();
    }
  }

  get active() {
    return this.status === "waiting" || this.status === "verifying";
  }

  finish(outcome: AssistanceOutcome) {
    if (!this.active) {
      return;
    }
    this.status = outcome;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.abort);
    this.settle(outcome);
  }

  cancel() {
    this.finish("cancelled");
  }

  complete(): Promise<boolean> {
    if (this.checking) {
      return this.checking;
    }
    if (!this.active) {
      return Promise.resolve(this.status === "resumed");
    }
    this.status = "verifying";
    this.checking = this.options
      .verify()
      .then((clear) => {
        if (!this.active) {
          return false;
        }
        if (clear) {
          this.finish("resumed");
        } else {
          this.status = "waiting";
        }
        return clear;
      })
      .catch(() => {
        this.finish("unavailable");
        return false;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
}
