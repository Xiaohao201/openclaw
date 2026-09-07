import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { redactSensitiveText } from "../logging/redact.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
} from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { OpenClawPluginToolContext } from "./types.js";

type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

function normalizeAllowlist(list?: string[]) {
  return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.allowlist.has("group:plugins");
}

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  allowGatewaySubagentBinding?: boolean;
}) {
  if (
    params.allowGatewaySubagentBinding &&
    getActivePluginRegistryKey() &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable"
  ) {
    return getActivePluginRegistry() ?? resolveRuntimePluginRegistry(params.loadOptions);
  }
  return resolveRuntimePluginRegistry(params.loadOptions);
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const context = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.context.workspaceDir,
  });
  const normalized = normalizePluginsConfig(context.config.plugins);
  const report = (event: Record<string, unknown>) =>
    context.logger.info(
      `tool-availability ${JSON.stringify({ sessionKey: params.context.sessionKey, ...event })}`,
    );
  if (!normalized.enabled) {
    report({ stage: "plugins-disabled", available: [] });
    return [];
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const loadOptions = buildPluginRuntimeLoadOptions(context, { runtimeOptions });
  const registry = resolvePluginToolRegistry({
    loadOptions,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  if (!registry) {
    report({ stage: "plugin-registry-unavailable", available: [] });
    return [];
  }
  report({
    stage: "plugin-registry",
    plugins: (registry.plugins ?? [])
      .map((plugin) => ({
        id: plugin.id,
        status: plugin.status,
        toolNames: plugin.toolNames.toSorted(),
        reason: plugin.error ? redactSensitiveText(plugin.error).slice(0, 1000) : undefined,
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  });

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();

  for (const entry of registry.tools) {
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      if (!params.suppressNameConflicts) {
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
      }
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
    try {
      resolved = entry.factory(params.context);
    } catch (err) {
      context.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) {
      report({
        stage: "plugin-factory-empty",
        pluginId: entry.pluginId,
        declared: entry.names.toSorted(),
      });
      if (entry.names.length > 0) {
        context.logger.debug?.(
          `plugin tool factory returned null (${entry.pluginId}): [${entry.names.join(", ")}]`,
        );
      }
      continue;
    }
    const listRaw = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: tool.name,
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : listRaw;
    if (list.length !== listRaw.length) {
      const retained = new Set(list.map((tool) => tool.name));
      report({
        stage: "optional-plugin-tool-policy",
        pluginId: entry.pluginId,
        removed: listRaw
          .map((tool) => tool.name)
          .filter((name) => !retained.has(name))
          .toSorted(),
      });
    }
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const tool of list) {
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        if (!params.suppressNameConflicts) {
          context.logger.error(message);
          registry.diagnostics.push({
            level: "error",
            pluginId: entry.pluginId,
            source: entry.source,
            message,
          });
        }
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      tools.push(tool);
    }
  }

  report({
    stage: "plugin-tools-resolved",
    available: tools
      .map((tool) => ({ name: tool.name, pluginId: pluginToolMeta.get(tool)?.pluginId }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  });
  return tools;
}
