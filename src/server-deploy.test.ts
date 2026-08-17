import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const sandboxTracker = createSuiteTempRootTracker({ prefix: "openclaw-server-deploy-" });

type Sandbox = {
  binDir: string;
  logPath: string;
  runDir: string;
};

async function createSandbox(): Promise<Sandbox> {
  const root = await sandboxTracker.make("suite");
  const binDir = join(root, "bin");
  const logPath = join(root, "commands.log");
  const runDir = join(root, "caller");
  await mkdir(binDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(logPath, "");
  await writeFile(
    join(binDir, "git.cmd"),
    [
      "@echo off",
      'echo %CD%^|%*>>"%DEPLOY_TEST_LOG%"',
      'if "%DEPLOY_TEST_FAIL_COMMAND%"=="pull" if "%~1 %~2 %~3"=="pull origin v1" exit /b 21',
      "exit /b 0",
      "",
    ].join("\r\n"),
  );
  await writeFile(
    join(binDir, "pnpm.cmd"),
    [
      "@echo off",
      'echo %CD%^|%*>>"%DEPLOY_TEST_LOG%"',
      'if "%DEPLOY_TEST_FAIL_COMMAND%"=="install" if "%~1"=="install" exit /b 22',
      'if "%DEPLOY_TEST_FAIL_COMMAND%"=="build" if "%~1"=="build" exit /b 23',
      'if "%DEPLOY_TEST_FAIL_COMMAND%"=="stop" if "%~1"=="openclaw" if "%~2"=="gateway" if "%~3"=="stop" exit /b 24',
      "exit /b 0",
      "",
    ].join("\r\n"),
  );
  return { binDir, logPath, runDir };
}

function runDeploy(sandbox: Sandbox, failCommand?: "pull" | "install" | "build" | "stop") {
  return spawnSync("cmd.exe", ["/d", "/c", join(repoRoot, "deploy-server.cmd")], {
    cwd: sandbox.runDir,
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}${delimiter}${process.env.PATH ?? ""}`,
      DEPLOY_TEST_FAIL_COMMAND: failCommand ?? "",
      DEPLOY_TEST_LOG: sandbox.logPath,
    },
    encoding: "utf8",
  });
}

async function readCommands(sandbox: Sandbox): Promise<string[]> {
  return (await readFile(sandbox.logPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf("|") + 1));
}

describe.skipIf(process.platform !== "win32")("deploy-server.cmd", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    await sandboxTracker.setup();
    sandbox = await createSandbox();
  });

  afterAll(async () => {
    await sandboxTracker.cleanup();
  });

  it("pulls, installs, builds, stops the old gateway, and runs the new gateway in the foreground", async () => {
    const result = runDeploy(sandbox);
    expect(result.status, result.stderr).toBe(0);
    expect(await readCommands(sandbox)).toEqual([
      "pull origin v1",
      "install",
      "build",
      "openclaw gateway stop",
      "openclaw gateway",
    ]);
  });

  it("does not stop or start the gateway when the build fails", async () => {
    await writeFile(sandbox.logPath, "");
    const result = runDeploy(sandbox, "build");
    expect(result.status).toBe(23);
    expect(await readCommands(sandbox)).toEqual(["pull origin v1", "install", "build"]);
  });

  it("does not start a new gateway when stopping the old one fails", async () => {
    await writeFile(sandbox.logPath, "");
    const result = runDeploy(sandbox, "stop");
    expect(result.status).toBe(24);
    expect(await readCommands(sandbox)).toEqual([
      "pull origin v1",
      "install",
      "build",
      "openclaw gateway stop",
    ]);
  });

  it("uses UTF-8 and invokes pnpm directly instead of a managed-service script", async () => {
    const launcher = await readFile(join(repoRoot, "deploy-server.cmd"), "utf8");
    expect(launcher).toMatch(/chcp\s+65001\s*>nul/iu);
    expect(launcher).toContain('set "PYTHONUTF8=1"');
    expect(launcher).not.toContain("server-deploy.ps1");
    expect(launcher).toContain("call pnpm openclaw gateway stop");
    expect(launcher).toContain("call pnpm openclaw gateway");
  });
});
