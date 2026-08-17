import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const sandboxTracker = createSuiteTempRootTracker({ prefix: "openclaw-server-deploy-" });

type Sandbox = {
  binDir: string;
  controllerDir: string;
  dataDir: string;
  failMarker: string;
  logPath: string;
  scriptPath: string;
};

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function createSandbox(): Promise<Sandbox> {
  const root = await sandboxTracker.make("suite");
  const controllerDir = join(root, "controller");
  const remoteDir = join(root, "remote.git");
  const binDir = join(root, "bin");
  const dataDir = join(root, "deploy-data");
  const logPath = join(root, "commands.log");
  const failMarker = join(root, "failed-once");
  const scriptPath = join(controllerDir, "scripts", "server-deploy.ps1");

  await mkdir(join(controllerDir, "scripts"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(logPath, "");
  run("git", ["init", "--bare", remoteDir], root);
  run("git", ["init", controllerDir], root);
  run("git", ["config", "user.email", "deploy-test@example.invalid"], controllerDir);
  run("git", ["config", "user.name", "Deploy Test"], controllerDir);
  await writeFile(join(controllerDir, "package.json"), '{"name":"deploy-fixture"}\n');
  await writeFile(join(controllerDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(controllerDir, "version.txt"), "one\n");
  run("git", ["add", "package.json", "pnpm-lock.yaml", "version.txt"], controllerDir);
  run("git", ["commit", "-m", "initial"], controllerDir);
  run("git", ["branch", "-M", "v1"], controllerDir);
  run("git", ["remote", "add", "origin", remoteDir], controllerDir);
  run("git", ["push", "-u", "origin", "v1"], controllerDir);

  await copyFile(join(repoRoot, "scripts", "server-deploy.ps1"), scriptPath);
  await chmod(scriptPath, 0o755);
  await writeFile(
    join(binDir, "node.cmd"),
    '@echo off\r\nif "%~1"=="--version" echo v22.0.0\r\nexit /b 0\r\n',
  );
  await writeFile(
    join(binDir, "pnpm.cmd"),
    [
      "@echo off",
      'echo %CD%^|%*>>"%DEPLOY_TEST_LOG%"',
      'if "%~1"=="build" (',
      "  if not exist dist mkdir dist",
      "  echo export {};>dist\\index.js",
      ")",
      'echo %*|%SystemRoot%\\System32\\findstr.exe /C:"gateway status" >nul',
      "if not errorlevel 1 (",
      '  if "%DEPLOY_TEST_FAIL_HEALTH_ONCE%"=="1" if not exist "%DEPLOY_TEST_FAIL_MARKER%" (',
      '    type nul>"%DEPLOY_TEST_FAIL_MARKER%"',
      "    exit /b 1",
      "  )",
      ")",
      "exit /b 0",
      "",
    ].join("\r\n"),
  );

  return { binDir, controllerDir, dataDir, failMarker, logPath, scriptPath };
}

function deployEnv(sandbox: Sandbox, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}${delimiter}${process.env.PATH ?? ""}`,
    DEPLOY_TEST_FAIL_MARKER: sandbox.failMarker,
    DEPLOY_TEST_LOG: sandbox.logPath,
    OPENCLAW_DEPLOY_DATA_DIR: sandbox.dataDir,
    OPENCLAW_DEPLOY_STATE_DIR: join(sandbox.dataDir, "state"),
    ...overrides,
  };
}

function runDeploy(sandbox: Sandbox, action?: string, overrides = {}) {
  const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sandbox.scriptPath];
  if (action) {
    args.push(action);
  }
  return spawnSync("powershell.exe", args, {
    cwd: sandbox.controllerDir,
    env: deployEnv(sandbox, overrides),
    encoding: "utf8",
  });
}

async function commitAndPushUpdate(sandbox: Sandbox) {
  await writeFile(join(sandbox.controllerDir, "version.txt"), "two\n");
  run("git", ["add", "version.txt"], sandbox.controllerDir);
  run("git", ["commit", "-m", "second"], sandbox.controllerDir);
  run("git", ["push", "origin", "v1"], sandbox.controllerDir);
}

describe.skipIf(process.platform !== "win32")("scripts/server-deploy.ps1", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    await sandboxTracker.setup();
    sandbox = await createSandbox();
  });

  afterAll(async () => {
    await sandboxTracker.cleanup();
  });

  it("builds an isolated release and hands the gateway to a managed Windows task", async () => {
    const result = runDeploy(sandbox);
    expect(result.status, result.stderr).toBe(0);

    const state = JSON.parse(
      await readFile(join(sandbox.dataDir, "state", "state.json"), "utf8"),
    ) as { currentSha: string; previousSha?: string };
    expect(state.currentSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(state.previousSha).toBeUndefined();

    const log = await readFile(sandbox.logPath, "utf8");
    expect(log).toContain("install --frozen-lockfile");
    expect(log).not.toMatch(/\|check(?:\s|$)/);
    expect(log).toContain("|build");
    expect(log).toContain("openclaw backup create --verify --no-include-workspace --output");
    expect(log).toContain("openclaw doctor --non-interactive");
    expect(log).toContain("openclaw gateway install --force --runtime node");
    expect(log).toContain("openclaw gateway restart");
    expect(log).toContain("openclaw gateway status --require-rpc --deep --json");
  });

  it("restores the previous release when the new gateway fails its health gate", async () => {
    const firstState = JSON.parse(
      await readFile(join(sandbox.dataDir, "state", "state.json"), "utf8"),
    ) as { currentSha: string };
    await commitAndPushUpdate(sandbox);
    await writeFile(sandbox.logPath, "");

    const result = runDeploy(sandbox, undefined, { DEPLOY_TEST_FAIL_HEALTH_ONCE: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("previous release was restored");

    const state = JSON.parse(
      await readFile(join(sandbox.dataDir, "state", "state.json"), "utf8"),
    ) as { currentSha: string };
    expect(state.currentSha).toBe(firstState.currentSha);
    const log = await readFile(sandbox.logPath, "utf8");
    expect(log.match(/openclaw gateway install --force --runtime node/g)).toHaveLength(2);
    expect(log.match(/openclaw gateway restart/g)).toHaveLength(2);
  });

  it("supports an explicit rollback after a later successful deployment", async () => {
    const deployment = runDeploy(sandbox);
    expect(deployment.status, deployment.stderr).toBe(0);
    const deployedState = JSON.parse(
      await readFile(join(sandbox.dataDir, "state", "state.json"), "utf8"),
    ) as { currentSha: string; previousSha: string };
    expect(deployedState.previousSha).toMatch(/^[0-9a-f]{40,64}$/);

    await writeFile(sandbox.logPath, "");
    const rollback = runDeploy(sandbox, "rollback");
    expect(rollback.status, rollback.stderr).toBe(0);
    const rolledBackState = JSON.parse(
      await readFile(join(sandbox.dataDir, "state", "state.json"), "utf8"),
    ) as { currentSha: string; previousSha: string };
    expect(rolledBackState.currentSha).toBe(deployedState.previousSha);
    expect(rolledBackState.previousSha).toBe(deployedState.currentSha);

    const status = runDeploy(sandbox, "status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`Current release: ${rolledBackState.currentSha}`);
  });

  it("keeps dry runs read-only and rejects unsafe Git selectors", async () => {
    const dryRunData = join(sandbox.dataDir, "dry-run-only");
    const dryRun = runDeploy(sandbox, "dry-run", {
      OPENCLAW_DEPLOY_DATA_DIR: dryRunData,
      OPENCLAW_DEPLOY_STATE_DIR: join(dryRunData, "state"),
    });
    expect(dryRun.status, dryRun.stderr).toBe(0);
    await expect(readFile(join(dryRunData, "state", "state.json"), "utf8")).rejects.toThrow();

    const injected = runDeploy(sandbox, "dry-run", {
      OPENCLAW_DEPLOY_REMOTE: "origin;Write-Host-pwned",
    });
    expect(injected.status).not.toBe(0);
    expect(injected.stderr).toContain("Invalid Git remote");
  });

  it("keeps the root launcher minimal and bypasses local execution-policy friction", async () => {
    const launcher = await readFile(join(repoRoot, "deploy-server.cmd"), "utf8");
    expect(launcher).toContain("-ExecutionPolicy Bypass");
    expect(launcher).toContain("scripts\\server-deploy.ps1");
  });
});
