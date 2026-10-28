import { isTruthyEnvValue } from "../infra/env.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

type LazyServiceModule = Record<string, unknown>;

export type LazyPluginServiceHandle = {
  stop: () => Promise<void>;
  handoff?: OpenClawPluginService["handoff"];
};

function resolveExport<T>(mod: LazyServiceModule, names: string[]): T | null {
  for (const name of names) {
    const value = mod[name];
    if (typeof value === "function") {
      return value as T;
    }
  }
  return null;
}

export async function startLazyPluginServiceModule(params: {
  skipEnvVar?: string;
  overrideEnvVar?: string;
  validateOverrideSpecifier?: (specifier: string) => string;
  loadDefaultModule: () => Promise<LazyServiceModule>;
  loadOverrideModule?: (specifier: string) => Promise<LazyServiceModule>;
  startExportNames: string[];
  stopExportNames?: string[];
  serviceContext?: OpenClawPluginServiceContext;
  handoffExportName?: string;
}): Promise<LazyPluginServiceHandle | null> {
  const skipEnvVar = params.skipEnvVar?.trim();
  if (skipEnvVar && isTruthyEnvValue(process.env[skipEnvVar])) {
    return null;
  }

  const overrideEnvVar = params.overrideEnvVar?.trim();
  const override = overrideEnvVar ? process.env[overrideEnvVar]?.trim() : undefined;
  const loadOverrideModule =
    params.loadOverrideModule ?? (async (specifier: string) => await import(specifier));
  const validatedOverride =
    override && params.validateOverrideSpecifier
      ? params.validateOverrideSpecifier(override)
      : override;
  const mod = validatedOverride
    ? await loadOverrideModule(validatedOverride)
    : await params.loadDefaultModule();
  const start = resolveExport<() => Promise<unknown>>(mod, params.startExportNames);
  if (!start) {
    if (params.serviceContext?.lifecycleMode) {
      throw new Error("Managed lazy service is missing its start export");
    }
    return null;
  }
  const stop =
    params.stopExportNames && params.stopExportNames.length > 0
      ? resolveExport<() => Promise<void>>(mod, params.stopExportNames)
      : null;

  let handoff: OpenClawPluginService["handoff"];
  if (params.serviceContext?.lifecycleMode) {
    const factory = params.handoffExportName
      ? resolveExport<(ctx: OpenClawPluginServiceContext) => OpenClawPluginService["handoff"]>(
          mod,
          [params.handoffExportName],
        )
      : null;
    if (!factory || !stop) {
      throw new Error("Managed lazy service requires handoff and stop exports");
    }
    handoff = factory(params.serviceContext);
    if (
      !handoff ||
      handoff.version !== 2 ||
      handoff.drainPhase !== "execution" ||
      typeof handoff.pause !== "function" ||
      typeof handoff.resume !== "function" ||
      typeof handoff.isReady !== "function"
    ) {
      throw new Error("Managed lazy service requires an execution handoff v2 contract");
    }
  }
  try {
    await start();
  } catch (cause) {
    const [cleanup] = await Promise.allSettled([Promise.resolve().then(() => stop?.())]);
    if (cleanup.status === "rejected") {
      const failure = new AggregateError(
        [cause, cleanup.reason],
        "Lazy service start and cleanup failed",
        {
          cause,
        },
      );
      throw failure;
    }
    throw cause;
  }
  return {
    stop: stop ?? (async () => {}),
    handoff,
  };
}
