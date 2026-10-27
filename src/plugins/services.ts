import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
function createPluginLogger(): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function createServiceContext(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
}): OpenClawPluginServiceContext {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
  };
}

export type PluginServicesHandle = {
  assertHealthy?: () => void;
  stop: (options?: { strict?: boolean }) => Promise<void>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir?: string;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];
  const startupFailures: unknown[] = [];
  const serviceContext = createServiceContext({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  for (const entry of params.registry.services) {
    const service = entry.service;
    running.push({
      id: service.id,
      stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
    });
    try {
      await service.start(serviceContext);
    } catch (err) {
      startupFailures.push(err);
      const error = err as Error;
      const stack = error?.stack?.trim();
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}${stack ? `\n${stack}` : ""}`,
      );
    }
  }

  let stopping: Promise<void> | undefined;
  const failures: unknown[] = [];
  return {
    assertHealthy: () => {
      if (startupFailures.length) {
        throw new AggregateError(startupFailures, "Plugin service startup failed");
      }
    },
    stop: async (options) => {
      stopping ??= (async () => {
        for (const entry of running.toReversed()) {
          if (!entry.stop) {
            continue;
          }
          try {
            await entry.stop();
          } catch (err) {
            failures.push(err);
            log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
          }
        }
      })();
      await stopping;
      if (options?.strict && failures.length > 0) {
        throw new AggregateError(failures, "Plugin services did not stop cleanly");
      }
    },
  };
}
