import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;
export type RabbitMqDebugBuildTarget = "gateway" | "control-ui";

const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function planRabbitMqDebugBuilds(params: {
  hasGatewayEntry: boolean;
  hasControlUiIndex: boolean;
}): RabbitMqDebugBuildTarget[] {
  const targets: RabbitMqDebugBuildTarget[] = [];
  if (!params.hasGatewayEntry) {
    targets.push("gateway");
  }
  if (!params.hasControlUiIndex) {
    targets.push("control-ui");
  }
  return targets;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const cloned: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (!BLOCKED_OBJECT_KEYS.has(key)) {
      cloned[key] = cloneJsonValue(child);
    }
  }
  return cloned;
}

function mergeJsonObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged = cloneJsonValue(base) as JsonObject;
  for (const [key, overrideValue] of Object.entries(override)) {
    if (BLOCKED_OBJECT_KEYS.has(key)) {
      continue;
    }
    const baseValue = merged[key];
    merged[key] =
      isJsonObject(baseValue) && isJsonObject(overrideValue)
        ? mergeJsonObjects(baseValue, overrideValue)
        : cloneJsonValue(overrideValue);
  }
  return merged;
}

function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function removeDisabledPluginConfigs(merged: JsonObject, development: JsonObject): void {
  const mergedPlugins = asJsonObject(merged.plugins);
  const mergedEntries = asJsonObject(mergedPlugins.entries);
  const developmentEntries = asJsonObject(asJsonObject(development.plugins).entries);
  for (const [id, value] of Object.entries(developmentEntries)) {
    if (asJsonObject(value).enabled !== false) {
      continue;
    }
    const entry = asJsonObject(mergedEntries[id]);
    delete entry.config;
    mergedEntries[id] = entry;
  }
}

function inheritProductionAgentsWithDevelopmentWorkspace(params: {
  merged: JsonObject;
  production: JsonObject;
  development: JsonObject;
}): void {
  const productionAgents = asJsonObject(params.production.agents);
  const developmentDefaults = asJsonObject(asJsonObject(params.development.agents).defaults);
  const agents = cloneJsonValue(productionAgents) as JsonObject;
  const defaults = asJsonObject(agents.defaults);

  // OPENCLAW_STATE_DIR isolates sessions and agent state. The workspace path is
  // the sole development-side agents override; model selection and every other
  // agent default must remain byte-for-byte aligned with deployment.
  if (Object.hasOwn(developmentDefaults, "workspace")) {
    defaults.workspace = cloneJsonValue(developmentDefaults.workspace);
  }

  if (Object.keys(defaults).length > 0) {
    agents.defaults = defaults;
  }
  if (Object.keys(agents).length > 0) {
    params.merged.agents = agents;
  } else {
    delete params.merged.agents;
  }
}

export function buildInheritedLocalDebugConfig(params: {
  production: JsonObject;
  development: JsonObject;
}): JsonObject {
  const merged = mergeJsonObjects(params.production, params.development);
  removeDisabledPluginConfigs(merged, params.development);

  inheritProductionAgentsWithDevelopmentWorkspace({
    merged,
    production: params.production,
    development: params.development,
  });

  // Keep the deployed extension connections unless the development config
  // explicitly overrides one. The dedicated debug command isolates only the
  // two write surfaces that belong to this ingress: history and RabbitMQ.

  const hooks = asJsonObject(cloneJsonValue(merged.hooks));
  delete hooks.gmail;
  hooks.internal = mergeJsonObjects(asJsonObject(hooks.internal), { enabled: false });
  merged.hooks = hooks;

  // Tool policy must match the production baseline. The dev config exists for
  // local Gateway identity and agent state; allowing it to narrow or widen
  // tools makes this simulator behave differently from the deployed channel.
  if (Object.hasOwn(params.production, "tools")) {
    merged.tools = cloneJsonValue(params.production.tools);
  } else {
    delete merged.tools;
  }

  return mergeJsonObjects(merged, {
    plugins: {
      entries: {
        "rabbitmq-consumer": {
          enabled: true,
          config: {
            rabbitmq: { queue: "MessageTest" },
            localDebug: { enabled: true, historyTable: "history_test" },
          },
        },
      },
    },
  });
}

export async function writeTemporaryInheritedConfig(params: {
  config: JsonObject;
  tempRoot: string;
}): Promise<{ directory: string; configPath: string; cleanup: () => Promise<void> }> {
  await mkdir(params.tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(params.tempRoot, "rabbitmq-local-debug-"));
  await chmod(directory, 0o700);
  const configPath = path.join(directory, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(params.config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  let cleaned = false;
  return {
    directory,
    configPath,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await rm(directory, { force: true, recursive: true });
    },
  };
}

export function buildRabbitMqDebugLaunchSpec(params: {
  entryPath: string;
  configPath: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = {
    ...params.env,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_SKIP_CHANNELS: "1",
  };
  delete env.OPENCLAW_PROFILE;
  // Start every plugin service normally. rabbitmq-consumer skips only its own
  // real queue client when localDebug.enabled=true; a global skip would also
  // disable cron-backed and service-backed capabilities that this simulator
  // is expected to inherit from deployment.
  delete env.OPENCLAW_SKIP_PLUGIN_SERVICES;
  return {
    command: process.execPath,
    args: [
      "--disable-warning=ExperimentalWarning",
      "--enable-source-maps",
      params.entryPath,
      "--log-level",
      "debug",
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      "19001",
      "--force",
    ],
    env,
  };
}
