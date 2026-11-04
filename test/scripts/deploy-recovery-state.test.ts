import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DeploymentEvents,
  RecoveryState,
  recoveryConfigSchema,
} from "../../scripts/deploy-recovery-state.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-state-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("persists budget, retains future timestamps, and requires explicit reset after blocking", async () => {
  const file = path.join(root, "state.json");
  const config = recoveryConfigSchema.parse({ maxAttempts: 2, delaysMs: [5, 15], windowMs: 1000 });
  const first = new RecoveryState(file);
  await first.load();
  expect(await first.attempt(config, 2000)).toBe(5);
  const next = new RecoveryState(file);
  await next.load();
  expect(await next.attempt(config, 1000)).toBe(15);
  expect(await next.attempt(config, 1100)).toBeNull();
  expect(next.blocked).toBe(true);
  expect(await next.attempt(config, 10000)).toBeNull();
  await next.reset();
  expect(await next.attempt(config, 10000)).toBe(5);
  expect(await next.attempt(config, 12000)).toBe(5);
});
it("refuses startup with a live prior owner or corrupt state", async () => {
  const file = path.join(root, "state.json");
  const state = new RecoveryState(file);
  await state.owners([process.pid]);
  await expect(new RecoveryState(file).load()).rejects.toThrow("may still own execution");
  await fs.writeFile(file, "invalid");
  await expect(new RecoveryState(file).load()).rejects.toThrow();
});
it("rotates serialized event records without losing the newest event", async () => {
  const file = path.join(root, "events.jsonl");
  const log = new DeploymentEvents(file, 1);
  await Promise.all([log.write("first"), log.write("second")]);
  expect(JSON.parse(await fs.readFile(file, "utf8")).event).toBe("second");
  expect(JSON.parse(await fs.readFile(`${file}.1`, "utf8")).event).toBe("first");
});
