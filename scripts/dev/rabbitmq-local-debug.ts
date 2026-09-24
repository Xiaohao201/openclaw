import { spawn } from "node:child_process";
import { existsSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { z } from "zod";
import { resolveConfigIncludes } from "../../src/config/includes.js";
import {
  buildInheritedLocalDebugConfig,
  buildRabbitMqDebugLaunchSpec,
  planRabbitMqDebugBuilds,
  type RabbitMqDebugBuildTarget,
  writeTemporaryInheritedConfig,
} from "./rabbitmq-local-debug-config.js";

async function runBuildTarget(repoRoot: string, target: RabbitMqDebugBuildTarget): Promise<void> {
  const args =
    target === "gateway"
      ? [path.join(repoRoot, "scripts", "build-all.mjs")]
      : [path.join(repoRoot, "scripts", "ui.js"), "build"];
  const label = target === "gateway" ? "Gateway" : "Control UI";
  process.stdout.write(`${label} build is missing; building it now.\n`);
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`${label} build failed with exit code ${exitCode}.`);
  }
}

function parseConfig(raw: string, configPath: string): Record<string, unknown> {
  const parsed: unknown = JSON5.parse(raw);
  const resolved = resolveConfigIncludes(parsed, configPath);
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
    throw new Error(`OpenClaw config must be an object: ${configPath}`);
  }
  return resolved as Record<string, unknown>;
}

async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  return parseConfig(await readFile(configPath, "utf8"), configPath);
}

async function main(): Promise<void> {
  const homeDir = os.homedir();
  const productionConfigPath =
    process.env.OPENCLAW_REAL_CONFIG_PATH?.trim() ||
    path.join(homeDir, ".openclaw", "openclaw.json");
  const developmentStateDir =
    process.env.OPENCLAW_DEV_STATE_DIR?.trim() || path.join(homeDir, ".openclaw-dev");
  const developmentConfigPath =
    process.env.OPENCLAW_DEV_CONFIG_PATH?.trim() || path.join(developmentStateDir, "openclaw.json");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entryPath = path.join(repoRoot, "dist", "entry.js");
  const controlUiIndexPath = path.join(repoRoot, "dist", "control-ui", "index.html");

  const buildTargets = planRabbitMqDebugBuilds({
    hasGatewayEntry: existsSync(entryPath),
    hasControlUiIndex: existsSync(controlUiIndexPath),
  });
  for (const target of buildTargets) {
    await runBuildTarget(repoRoot, target);
  }
  if (!existsSync(entryPath) || !existsSync(controlUiIndexPath)) {
    throw new Error("Suheng debug build artifacts are still missing after the build completed.");
  }

  const [production, development] = await Promise.all([
    readConfig(productionConfigPath),
    readConfig(developmentConfigPath),
  ]);
  const merged = buildInheritedLocalDebugConfig({ production, development });
  let experiment: { close: () => Promise<void> } | undefined;
  let metricsFd: number | undefined;
  let turnRouterUrl: string | undefined;
  const experimentMode = process.env.OPENCLAW_JEV_DEBUG_MODE;
  if (experimentMode) {
    if (
      experimentMode !== "baseline" &&
      experimentMode !== "filter" &&
      experimentMode !== "route"
    ) {
      throw new Error("OPENCLAW_JEV_DEBUG_MODE must be baseline, filter, or route");
    }
    const provider = z
      .object({ api: z.literal("openai-completions"), baseUrl: z.string() })
      .parse(
        (merged.models as { providers?: Record<string, unknown> } | undefined)?.providers?.qwen,
      );
    const { startDebugProxy } = await import("../../extensions/jev-router/api.js");
    if (process.env.OPENCLAW_JEV_DEBUG_METRICS) {
      metricsFd = openSync(process.env.OPENCLAW_JEV_DEBUG_METRICS, "wx", 0o600);
    }
    const proxy = await startDebugProxy({
      upstream: provider.baseUrl,
      mode: experimentMode,
      log: (record) => {
        const line = JSON.stringify(record) + "\n";
        process.stdout.write(`[JEV_DEBUG] ${line}`);
        if (metricsFd !== undefined) {
          writeSync(metricsFd, line);
        }
      },
    });
    experiment = proxy;
    turnRouterUrl = proxy.turnRouterUrl;
    const providers = (merged.models as { providers: Record<string, Record<string, unknown>> })
      .providers;
    providers.qwen = { ...providers.qwen, baseUrl: proxy.baseUrl };
    process.stdout.write(
      `JEV synthetic debug experiment: ${experimentMode}; maximum 16 model requests; qwen provider only.\n`,
    );
  }
  const temporary = await writeTemporaryInheritedConfig({
    config: merged,
    tempRoot: os.tmpdir(),
  }).catch(async (error: unknown) => {
    await experiment?.close();
    if (metricsFd !== undefined) {
      closeSync(metricsFd);
    }
    throw error;
  });
  const launch = buildRabbitMqDebugLaunchSpec({
    entryPath,
    configPath: temporary.configPath,
    stateDir: developmentStateDir,
    env: process.env,
  });
  if (experimentMode) {
    // Keep the HTTP debug runner, but do not start queue consumers or scheduled jobs.
    launch.env.OPENCLAW_SKIP_PLUGIN_SERVICES = "1";
    delete launch.env.JEV_OPENROUTER_API_KEY;
  }
  // Do not inherit an old endpoint into ordinary debug or other experiment modes.
  delete launch.env.OPENCLAW_DEBUG_TURN_ROUTER_URL;
  if (turnRouterUrl) {
    launch.env.OPENCLAW_DEBUG_TURN_ROUTER_URL = turnRouterUrl;
  }

  const cleanupSync = () => {
    rmSync(temporary.directory, { force: true, recursive: true });
  };
  process.once("exit", cleanupSync);

  try {
    process.stdout.write(
      "Starting loopback RabbitMQ debug Gateway with inherited real configuration " +
        "and isolated dev state. Existing MySQL and Milvus connections are reused; " +
        "chat history is isolated to history_test and RabbitMQ is set to MessageTest. " +
        "Secrets are not logged.\n",
    );
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
      stdio: "inherit",
      windowsHide: true,
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    process.exitCode = exitCode;
  } finally {
    process.removeListener("exit", cleanupSync);
    await temporary.cleanup();
    await experiment?.close();
    if (metricsFd !== undefined) {
      closeSync(metricsFd);
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`RabbitMQ local debug startup failed: ${message}\n`);
  process.exitCode = 1;
});
