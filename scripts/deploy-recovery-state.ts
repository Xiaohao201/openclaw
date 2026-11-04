import fs from "node:fs/promises";
import { z } from "zod";

export const recoveryConfigSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(100).default(5),
    windowMs: z.number().int().min(1000).default(900_000),
    delaysMs: z
      .array(z.number().int().min(1).max(300_000))
      .min(1)
      .default([5000, 15000, 30000, 60000]),
    healthIntervalMs: z.number().int().min(10).default(10_000),
    healthTimeoutMs: z.number().int().min(10).default(3000),
    healthFailures: z.number().int().min(1).default(3),
    retireTimeoutMs: z.number().int().min(100).default(30_000),
  })
  .strict();

const stateSchema = z
  .object({
    format: z.literal(1),
    attempts: z.array(z.number().finite().nonnegative()),
    blocked: z.boolean(),
    owners: z.array(z.number().int().positive()),
  })
  .strict();

/** Fail closed on malformed state or any possibly live previous owner, including PID reuse. */
export class RecoveryState {
  unclean = false;
  private data: z.infer<typeof stateSchema> = {
    format: 1,
    attempts: [],
    blocked: false,
    owners: [],
  };
  constructor(private file: string) {}

  async load() {
    try {
      this.data = stateSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.unclean = this.data.owners.length > 0;
    for (const pid of this.data.owners) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          continue;
        }
        throw error;
      }
      throw new Error(
        `Previous deployment worker ${pid} may still own execution; wait for exit or inspect it`,
      );
    }
    this.data.owners = [];
  }

  get blocked() {
    return this.data.blocked;
  }

  async save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.data) + "\n", { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  async owners(pids: number[]) {
    this.data.owners = pids;
    await this.save();
  }

  async block() {
    this.data.blocked = true;
    await this.save();
  }

  async reset() {
    this.data.blocked = false;
    this.data.attempts = [];
    await this.save();
  }

  async attempt(config: z.infer<typeof recoveryConfigSchema>, now = Date.now()) {
    // Future timestamps are retained so clock rollback cannot reset the budget.
    this.data.attempts = this.data.attempts.filter((time) => now - time < config.windowMs);
    if (this.data.blocked || this.data.attempts.length >= config.maxAttempts) {
      await this.block();
      return null;
    }
    this.data.attempts.push(now);
    await this.save();
    return config.delaysMs[Math.min(this.data.attempts.length - 1, config.delaysMs.length - 1)];
  }
}

/** Serialize and rotate diagnostics; never log config, environment values or request payloads. */
export class DeploymentEvents {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private file: string,
    private maxBytes = 5 * 1024 * 1024,
  ) {}
  write(event: string, fields: Record<string, string | number | null> = {}) {
    const next = this.pending.then(async () => {
      try {
        if ((await fs.stat(this.file)).size >= this.maxBytes) {
          await fs.rm(`${this.file}.1`, { force: true });
          await fs.rename(this.file, `${this.file}.1`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const line = JSON.stringify({ time: new Date().toISOString(), event, ...fields });
      await fs.appendFile(this.file, line + "\n", { mode: 0o600 });
      console.log(`[deploy] ${line}`);
    });
    this.pending = next.catch(() => {});
    return next;
  }
}
