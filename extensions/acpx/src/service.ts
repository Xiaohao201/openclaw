import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../runtime-api.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime-api.js";
import {
  resolveAcpxPluginConfig,
  toAcpMcpServers,
  type ResolvedAcpxPluginConfig,
} from "./config.js";
import { createManagedAcpRuntime } from "./managed-runtime.js";
import {
  ACPX_BACKEND_ID,
  AcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "./runtime.js";

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor?(): Promise<{
    ok: boolean;
    message: string;
    details?: string[];
  }>;
};

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  logger?: PluginLogger;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike;
};

function createDefaultRuntime(params: AcpxRuntimeFactoryParams): AcpxRuntimeLike {
  return new AcpxRuntime({
    cwd: params.pluginConfig.cwd,
    sessionStore: createFileSessionStore({
      stateDir: params.pluginConfig.stateDir,
    }),
    agentRegistry: createAgentRegistry({
      overrides: params.pluginConfig.agents,
    }),
    mcpServers: toAcpMcpServers(params.pluginConfig.mcpServers),
    permissionMode: params.pluginConfig.permissionMode,
    nonInteractivePermissions: params.pluginConfig.nonInteractivePermissions,
    timeoutMs:
      params.pluginConfig.timeoutSeconds != null
        ? params.pluginConfig.timeoutSeconds * 1_000
        : undefined,
  });
}

function warnOnIgnoredLegacyCompatibilityConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  logger?: PluginLogger;
}): void {
  const ignoredFields: string[] = [];
  if (params.pluginConfig.legacyCompatibilityConfig.queueOwnerTtlSeconds != null) {
    ignoredFields.push("queueOwnerTtlSeconds");
  }
  if (params.pluginConfig.legacyCompatibilityConfig.strictWindowsCmdWrapper === false) {
    ignoredFields.push("strictWindowsCmdWrapper=false");
  }
  if (ignoredFields.length === 0) {
    return;
  }
  params.logger?.warn(
    `embedded acpx runtime ignores legacy compatibility config: ${ignoredFields.join(", ")}`,
  );
}

function formatDoctorFailureMessage(report: { message: string; details?: string[] }): string {
  const detailText = report.details?.filter(Boolean).join("; ").trim();
  return detailText ? `${report.message} (${detailText})` : report.message;
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: AcpxRuntimeLike | null = null;
  let lifecycleRevision = 0;
  let managed: ReturnType<typeof createManagedAcpRuntime> | undefined;
  let initialized = false;
  let disabled = false;
  let probing: Promise<void> | undefined;

  return {
    id: "acpx-runtime",
    handoff: {
      version: 2,
      drainPhase: "execution",
      isReady: () => initialized && (disabled || (runtime?.isHealthy() ?? false)),
      pause: async (_ctx, timeoutMs) => {
        await managed?.pause(timeoutMs);
      },
      resume: async () => {
        if (!initialized || (!disabled && !runtime?.isHealthy())) {
          throw new Error("acpx-runtime is not ready");
        }
        managed?.work.resume();
      },
    },
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      if (initialized || runtime) {
        return;
      }
      if (ctx.lifecycleMode && ctx.handoffVersion !== 2) {
        throw new Error("acpx-runtime requires a host with handoff v2 support");
      }
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        disabled = true;
        initialized = true;
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }

      const pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      await fs.mkdir(pluginConfig.stateDir, { recursive: true });
      warnOnIgnoredLegacyCompatibilityConfig({
        pluginConfig,
        logger: ctx.logger,
      });

      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        logger: ctx.logger,
      });

      managed = ctx.lifecycleMode ? createManagedAcpRuntime(runtime) : undefined;
      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime: managed?.runtime ?? runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(`embedded acpx runtime backend registered (cwd: ${pluginConfig.cwd})`);

      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE === "1") {
        if (ctx.lifecycleMode && !runtime.isHealthy()) {
          throw new Error("acpx-runtime: skipped probe cannot establish managed readiness");
        }
        initialized = true;
        return;
      }

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      const currentRuntime = runtime;
      probing = (async () => {
        try {
          await currentRuntime.probeAvailability();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          if (runtime?.isHealthy()) {
            initialized = true;
            ctx.logger.info("embedded acpx runtime backend ready");
            return;
          }
          const doctorReport = await runtime?.doctor?.();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `embedded acpx runtime backend probe failed: ${doctorReport ? formatDoctorFailureMessage(doctorReport) : "backend remained unhealthy after probe"}`,
          );
          if (ctx.lifecycleMode) {
            throw new Error("acpx-runtime availability probe failed");
          }
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(`embedded acpx runtime setup failed: ${formatErrorMessage(err)}`);
          if (ctx.lifecycleMode) {
            throw err;
          }
        }
      })();
      if (ctx.lifecycleMode) {
        await probing;
      }
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      await managed?.pause(30_000);
      lifecycleRevision += 1;
      await probing?.catch(() => {});
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
      managed = undefined;
      initialized = false;
      disabled = false;
      probing = undefined;
    },
  };
}
