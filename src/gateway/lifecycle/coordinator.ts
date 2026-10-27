/** The manager owns process lifetime. Workers never terminate or restart themselves. */
export interface ManagedWorker {
  id: string;
  prepare(): Promise<void>;
  activate(): Promise<void>;
  quiesce(): Promise<void>;
  resume(): Promise<void>;
  deactivate(): Promise<void>;
  /** Must resolve only after process exit has been confirmed. */
  dispose(): Promise<void>;
  hasExited?(): boolean;
}

type Phase = "empty" | "preparing" | "active" | "draining" | "switching" | "failed";

export class GatewayLifecycleCoordinator {
  private active: ManagedWorker | undefined;
  private phase: Phase = "empty";
  private busy = false;
  private readonly retired = new Set<ManagedWorker>();

  private async retireOldWorkers(): Promise<void> {
    for (const worker of this.retired) {
      await worker.dispose();
      this.retired.delete(worker);
    }
  }

  snapshot(): { phase: Phase; workerId?: string } {
    return { phase: this.phase, ...(this.active ? { workerId: this.active.id } : {}) };
  }

  private enter(): void {
    if (this.busy) {
      throw new Error("A lifecycle operation is already in progress");
    }
    if (this.phase === "failed") {
      throw new Error("Lifecycle ownership is uncertain; external operator recovery is required");
    }
    this.busy = true;
  }

  async start(worker: ManagedWorker): Promise<void> {
    this.enter();
    try {
      if (this.active) {
        throw new Error("A worker is already active");
      }
      this.phase = "preparing";
      try {
        await worker.prepare();
        await worker.activate();
        this.active = worker;
        this.phase = "active";
        await worker.resume();
      } catch (error) {
        if (this.active === worker) {
          throw error;
        }
        this.phase = "failed";
        await worker.dispose();
        this.phase = "empty";
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }

  async replace(candidate: ManagedWorker): Promise<void> {
    this.enter();
    const previous = this.active;
    if (!previous || candidate.id === previous.id) {
      this.busy = false;
      throw new Error("Replacement requires an active worker and a new worker identity");
    }
    let quiesceAttempted = false;
    let deactivationAttempted = false;
    let committed = false;
    try {
      this.phase = "preparing";
      await candidate.prepare();
      this.phase = "draining";
      quiesceAttempted = true;
      await previous.quiesce();
      this.phase = "switching";
      deactivationAttempted = true;
      await previous.deactivate();
      await candidate.activate();
      this.active = candidate;
      this.phase = "active";
      committed = true;
      this.retired.add(previous);
      await candidate.resume();
      await this.retireOldWorkers();
    } catch (error) {
      if (committed) {
        // The replacement owns traffic now. Never roll back because old process cleanup failed.
        throw new Error(
          "Replacement owns the service; admission or old process cleanup needs operator attention",
          { cause: error },
        );
      }
      this.phase = "failed";
      // A timed-out activate may still be running. Confirm death before restoring the old writer.
      await candidate.dispose();
      if (deactivationAttempted) {
        await previous.activate();
        await previous.resume();
      } else if (quiesceAttempted) {
        await previous.resume();
      }
      this.phase = "active";
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    this.enter();
    try {
      if (!this.active) {
        return;
      }
      this.phase = "draining";
      try {
        await this.active.quiesce();
      } catch (error) {
        await this.active.resume();
        this.phase = "active";
        throw error;
      }
      this.phase = "switching";
      await this.active.deactivate();
      await this.active.dispose();
      await this.retireOldWorkers();
      this.active = undefined;
      this.phase = "empty";
    } finally {
      this.busy = false;
    }
  }

  async resume(): Promise<void> {
    this.enter();
    try {
      if (!this.active) {
        throw new Error("No worker owns the service");
      }
      await this.active.resume();
      await this.retireOldWorkers();
      this.phase = "active";
    } finally {
      this.busy = false;
    }
  }

  async recover(worker: ManagedWorker): Promise<void> {
    this.enter();
    try {
      if (!this.active?.hasExited?.()) {
        throw new Error("Crash recovery requires confirmed process exit");
      }
      this.active = undefined;
      this.phase = "empty";
    } finally {
      this.busy = false;
    }
    await this.start(worker);
  }
}
