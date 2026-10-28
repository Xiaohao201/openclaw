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
    ...(isExternallyManagedGateway()
      ? { lifecycleMode: "externally-managed" as const, handoffVersion: 2 as const }
      : {}),
  };
}

export type PluginServicesHandle = {
  handoff?: {
    pause: (timeoutMs: number) => Promise<void>;
    pauseExecution?: (timeoutMs: number) => Promise<void>;
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

  if (serviceContext.lifecycleMode) {
    const invalid = params.registry.services.filter(({ service }) => {
      const handoff = service.handoff;
      return (
        !handoff ||
        ![1, 2].includes(handoff.version) ||
        (handoff.version === 2 && !["ingress", "execution"].includes(handoff.drainPhase)) ||
        typeof handoff.pause !== "function" ||
        typeof handoff.resume !== "function" ||
        typeof handoff.isReady !== "function"
      );
    });
    if (invalid.length) {
      const failure = new Error(
        `Invalid managed service handoff contract: ${invalid
          .map(({ service }) => service.id)
          .toSorted()
          .join(", ")}`,
      );
      startupFailures.push(failure);
      log.error(failure.message);
    }
  }
  for (const entry of startupFailures.length ? [] : params.registry.services) {
    const service = entry.service;
    running.push({
      id: service.id,
      handoff: service.handoff,
      stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
    });
    try {
      await service.start(serviceContext);
    } catch (err) {
      startupFailures.push(
        new Error(
          `Service startup failed (${service.id}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      );
      const error = err as Error;
      const stack = error?.stack?.trim();
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}${stack ? `\n${stack}` : ""}`,
      );
    }
  }

  let stopping: Promise<void> | undefined;
  const failures: unknown[] = [];
  const isExecution = (entry: (typeof running)[number]) =>
    entry.handoff?.version === 2 && entry.handoff.drainPhase === "execution";
  const pausePhase = async (timeoutMs: number, execution: boolean) => {
    const unsupported = running.filter((entry) => !entry.handoff).map((entry) => entry.id);
    if (unsupported.length) {
      throw new Error(`Services do not support safe handoff: ${unsupported.toSorted().join(", ")}`);
    }
    const results = await Promise.allSettled(
      running
        .filter((entry) => isExecution(entry) === execution)
        .map(async (entry) => {
          try {
            await entry.handoff!.pause(serviceContext, timeoutMs);
          } catch (cause) {
            throw new Error(
              `Service drain failed (${entry.id}): ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            );
          }
        }),
    );
    const rejected = results.filter((result) => result.status === "rejected");
    if (rejected.length) {
      throw new AggregateError(
        rejected.map((result) => result.reason),
        `Service drain failed: ${rejected.map((result) => String(result.reason)).join("; ")}`,
      );
    }
  };
  return {
    handoff: {
      pause: (timeoutMs) => pausePhase(timeoutMs, false),
      pauseExecution: (timeoutMs) => pausePhase(timeoutMs, true),
      resume: async () => {
        for (const entry of [
          ...running.filter(isExecution),
          ...running.filter((entry) => !isExecution(entry)),
        ]) {
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
        throw new AggregateError(
          startupFailures,
          `Plugin service startup failed: ${startupFailures.map(String).join("; ")}`,
        );
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
