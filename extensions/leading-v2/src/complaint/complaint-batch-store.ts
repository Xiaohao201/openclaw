import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const batchIdSchema = z.string().uuid();
const entrySchema = z.object({
  link: z.string().min(1),
  acceptance: z.enum(["not_attempted", "inflight", "accepted", "rejected", "unknown"]),
  taskId: z.number().int().positive().safe().nullable(),
});
const batchSchema = z.object({
  version: z.literal(1),
  batchId: batchIdSchema,
  userId: z.string().min(1),
  createdAt: z.string(),
  entries: z.array(entrySchema).min(1).max(1000),
});
export type ComplaintBatch = z.infer<typeof batchSchema>;

/** A batch has one writer; independent calls use separate files, never a shared latest-task slot. */
export class ComplaintBatchStore {
  constructor(private readonly stateDir: () => string) {}

  private directory(userId: string) {
    return join(
      this.stateDir(),
      "leading-v2-complaint-batches",
      createHash("sha256").update(userId).digest("hex"),
    );
  }

  async create(userId: string, links: string[]): Promise<ComplaintBatch> {
    const batch = batchSchema.parse({
      version: 1,
      batchId: randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
      entries: links.map((link) => ({ link, acceptance: "not_attempted", taskId: null })),
    });
    await this.save(batch);
    return batch;
  }

  async save(value: ComplaintBatch): Promise<void> {
    const batch = batchSchema.parse(value);
    const directory = this.directory(batch.userId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${batch.batchId}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(batch), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async get(userId: string, batchId: string): Promise<ComplaintBatch | null> {
    if (!batchIdSchema.safeParse(batchId).success) {
      return null;
    }
    try {
      const batch = batchSchema.parse(
        JSON.parse(await readFile(join(this.directory(userId), `${batchId}.json`), "utf8")),
      );
      return batch.userId === userId && batch.batchId === batchId ? batch : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(userId: string): Promise<ComplaintBatch[]> {
    let names: string[];
    try {
      names = await readdir(this.directory(userId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const batches: ComplaintBatch[] = [];
    for (const name of names.toSorted()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const batch = await this.get(userId, name.slice(0, -5));
      if (batch) {
        batches.push(batch);
      }
    }
    return batches.toSorted(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.batchId.localeCompare(b.batchId),
    );
  }
}
