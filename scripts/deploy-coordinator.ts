export interface DeployWorker {
  activate(): Promise<void>;
  /** Resolves only after graceful drain AND confirmed process exit. */
  retire(): Promise<void>;
  /** A failed candidate must also exit before the previous release can start. */
  discard(): Promise<void>;
}

export type DeploymentPhase =
  | "running"
  | "preparing"
  | "draining"
  | "activating"
  | "rolling-back"
  | "blocked";

/** Serial, single-writer cutover. No timeout may authorize a second writer. */
export class DeployCoordinator<T extends DeployWorker = DeployWorker> {
  private busy = false;
  private blocked = false;
  constructor(
    private deps: {
      release: string;
      worker: T;
      prepare: (release: string) => Promise<T>;
      route: (worker: T | null) => void;
      record: (phase: DeploymentPhase, release: string) => Promise<void>;
    },
  ) {}

  async deploy(release: string, compatibleState: boolean): Promise<"deployed" | "rolled-back"> {
    if (this.busy) {
      throw new Error("Deployment already in progress");
    }
    if (this.blocked) {
      throw new Error("Deployment is blocked; inspect ownership before recovery");
    }
    if (!compatibleState) {
      throw new Error("State compatibility must be confirmed before automatic rollback");
    }
    this.busy = true;
    const previous = this.deps.release;
    let candidate: T | undefined;
    let retired = false;
    try {
      await this.deps.record("preparing", previous);
      candidate = await this.deps.prepare(release);
      await this.deps.record("draining", previous);
      this.deps.route(null);
      await this.deps.worker.retire();
      retired = true;
      await this.deps.record("activating", release);
      await candidate.activate();
      await this.deps.record("running", release);
      this.deps.worker = candidate;
      this.deps.release = release;
      this.deps.route(candidate);
      return "deployed";
    } catch (error) {
      // Even a failed activation can have started consumers. Never restart the
      // old release until the candidate acknowledges drain and actually exits.
      try {
        await candidate?.discard();
      } catch (discardError) {
        this.blocked = true;
        await this.deps.record("blocked", release);
        const failure = new AggregateError(
          [error, discardError],
          "Candidate could not relinquish ownership",
          { cause: discardError },
        );
        throw failure;
      }
      if (!retired) {
        this.blocked = candidate !== undefined;
        // If retirement started, the old worker may be partially stopped. Do
        // not reopen its admission or point clients at an uncertain owner.
        await this.deps.record(candidate ? "blocked" : "running", previous);
        throw error;
      }
      await this.deps.record("rolling-back", previous);
      try {
        const rollback = await this.deps.prepare(previous);
        this.deps.worker = rollback;
        await rollback.activate();
        await this.deps.record("running", previous);
        this.deps.route(rollback);
        return "rolled-back";
      } catch (rollbackError) {
        this.blocked = true;
        await this.deps.record("blocked", previous);
        const failure = new AggregateError(
          [error, rollbackError],
          "Deployment and rollback failed; ingress remains closed",
          { cause: rollbackError },
        );
        throw failure;
      }
    } finally {
      this.busy = false;
    }
  }
}
