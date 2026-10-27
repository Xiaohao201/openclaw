import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isExternallyManagedGateway } from "../infra/external-lifecycle.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "./types.js";

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
    ...(isExternallyManagedGateway() ? { lifecycleMode: "externally-managed" as const } : {}),
  };
}

export type PluginServicesHandle = {
  handoff?: {
    pause: (timeoutMs: number) => Promise<void>;
    resume: () => Promise<void>;
    isReady: () => boolean;
  };
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
    handoff?: OpenClawPluginService["handoff"];
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
      handoff: service.handoff,
      stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
    });
    try {
      if (serviceContext.lifecycleMode && !service.handoff) {
        throw new Error("Externally managed services require the v1 handoff contract");
      }
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
    handoff: {
      pause: async (timeoutMs) => {
        const unsupported = running.filter((entry) => !entry.handoff).map((entry) => entry.id);
        if (unsupported.length > 0) {
          throw new Error(
            `Services do not support safe handoff: ${unsupported.toSorted().join(", ")}`,
          );
        }
        // Settle every pause before rollback can resume any service.
        const results = await Promise.allSettled(
          running.map((entry) => entry.handoff!.pause(serviceContext, timeoutMs)),
        );
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Service drain failed",
          );
        }
      },
      resume: async () => {
        for (const entry of running) {
          await entry.handoff?.resume(serviceContext);
        }
      },
      isReady: () =>
        startupFailures.length === 0 &&
        running.length === params.registry.services.length &&
        running.every((entry) => entry.handoff?.isReady(serviceContext) ?? true),
    },
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
