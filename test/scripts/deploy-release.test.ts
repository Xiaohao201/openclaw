import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runReleaseCommand, writeReleaseLauncher } from "../../scripts/deploy-release.js";

let root: string;
let release: string;
let configFile: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-release-"));
  release = path.join(root, "002 with spaces");
  configFile = path.join(root, "supervisor/supervisor.json");
  await fs.mkdir(release);
  await fs.mkdir(path.dirname(configFile));
  await fs.writeFile(configFile, JSON.stringify({ journal: path.join(root, "journal.json") }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function dependencies() {
  return {
    verify: vi.fn(async () => {}),
    serve: vi.fn(async () => {}),
    send: vi.fn(async () => ({ phase: "running", release: path.join(root, "001"), pid: 123 })),
    log: vi.fn(),
  };
}

it("starts through the shared config with an explicit expected release", async () => {
  const deps = dependencies();
  await runReleaseCommand(configFile, release, ["serve"], deps);
  expect(deps.verify).toHaveBeenCalledWith(release);
  expect(deps.serve).toHaveBeenCalledWith(configFile, { expectedRelease: release });
  expect(deps.send).not.toHaveBeenCalled();
});

it("shows the actual release even when called from another release directory", async () => {
  const deps = dependencies();
  await runReleaseCommand(configFile, release, ["status"], deps);
  expect(deps.send).toHaveBeenCalledWith(path.join(root, "journal.json.commands"), {
    command: "status",
  });
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('"releaseMatches":false'));
  expect(deps.verify).not.toHaveBeenCalled();
});

it("requires explicit compatibility before deploying this release", async () => {
  const deps = dependencies();
  await expect(runReleaseCommand(configFile, release, ["deploy"], deps)).rejects.toThrow(
    "--compatible-state",
  );
  expect(deps.send).not.toHaveBeenCalled();
  await runReleaseCommand(configFile, release, ["deploy", "--compatible-state"], deps);
  expect(deps.send).toHaveBeenCalledWith(path.join(root, "journal.json.commands"), {
    command: "deploy",
    release,
    compatibleState: true,
  });
});

it("rejects invalid commands without touching the service", async () => {
  const deps = dependencies();
  for (const args of [[], ["unknown"], ["serve", "--force"], ["stop", "extra"]]) {
    await expect(runReleaseCommand(configFile, release, args, deps)).rejects.toThrow("Usage:");
  }
  expect(deps.send).not.toHaveBeenCalled();
  expect(deps.serve).not.toHaveBeenCalled();
});

it("stops the shared supervisor without requiring an intact release artifact", async () => {
  const deps = dependencies();
  await runReleaseCommand(configFile, release, ["stop"], deps);
  expect(deps.send).toHaveBeenCalledWith(path.join(root, "journal.json.commands"), {
    command: "stop",
  });
  expect(deps.verify).not.toHaveBeenCalled();
});

it("recovers through the shared supervisor and reports a matching release", async () => {
  const deps = dependencies();
  deps.send.mockResolvedValue({ phase: "running", release, pid: 123 });
  await runReleaseCommand(configFile, release, ["status"], deps);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('"releaseMatches":true'));
  await runReleaseCommand(configFile, release, ["recover"], deps);
  expect(deps.send).toHaveBeenCalledWith(path.join(root, "journal.json.commands"), {
    command: "recover",
  });
});

it("does not replace directories and propagates launcher filesystem failures", async () => {
  await expect(
    writeReleaseLauncher({ release: path.join(root, "missing"), configFile }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await fs.mkdir(path.join(release, "deploy.mjs"));
  await expect(writeReleaseLauncher({ release, configFile })).rejects.toThrow("already exists");
  expect((await fs.stat(path.join(release, "deploy.mjs"))).isDirectory()).toBe(true);
});

it("does not start or deploy an invalid artifact", async () => {
  const deps = dependencies();
  deps.verify.mockRejectedValue(new Error("invalid artifact"));
  await expect(runReleaseCommand(configFile, release, ["serve"], deps)).rejects.toThrow(
    "invalid artifact",
  );
  await expect(
    runReleaseCommand(configFile, release, ["deploy", "--compatible-state"], deps),
  ).rejects.toThrow("invalid artifact");
  expect(deps.send).not.toHaveBeenCalled();
  expect(deps.serve).not.toHaveBeenCalled();
});

it("generates a shell-free launcher usable outside the release cwd and preserves existing files", async () => {
  const launcher = await writeReleaseLauncher({ release, configFile });
  const result = spawnSync(process.execPath, [launcher, "unknown"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: node deploy.mjs");
  const original = await fs.readFile(launcher, "utf8");
  await writeReleaseLauncher({ release, configFile });
  expect(await fs.readFile(launcher, "utf8")).toBe(original);
  await fs.writeFile(launcher, "operator content");
  await expect(writeReleaseLauncher({ release, configFile })).rejects.toThrow("already exists");
  expect(await fs.readFile(launcher, "utf8")).toBe("operator content");
});
