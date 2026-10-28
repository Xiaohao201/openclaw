import { afterEach, describe, expect, it, vi } from "vitest";
import { startLazyPluginServiceModule } from "./lazy-service-module.js";

function createAsyncHookMock() {
  return vi.fn(async () => {});
}

function createLazyModuleLifecycle() {
  const start = createAsyncHookMock();
  const stop = createAsyncHookMock();
  return {
    start,
    stop,
    module: {
      startDefault: start,
      stopDefault: stop,
    },
  };
}

async function expectLifecycleStarted(params: {
  overrideEnvVar?: string;
  validateOverrideSpecifier?: (specifier: string) => string;
  loadDefaultModule?: () => Promise<Record<string, unknown>>;
  loadOverrideModule?: (spec: string) => Promise<Record<string, unknown>>;
  startExportNames: string[];
  stopExportNames?: string[];
}) {
  return startLazyPluginServiceModule({
    ...(params.overrideEnvVar ? { overrideEnvVar: params.overrideEnvVar } : {}),
    ...(params.validateOverrideSpecifier
      ? { validateOverrideSpecifier: params.validateOverrideSpecifier }
      : {}),
    loadDefaultModule: params.loadDefaultModule ?? (async () => createLazyModuleLifecycle().module),
    ...(params.loadOverrideModule ? { loadOverrideModule: params.loadOverrideModule } : {}),
    startExportNames: params.startExportNames,
    ...(params.stopExportNames ? { stopExportNames: params.stopExportNames } : {}),
  });
}

describe("startLazyPluginServiceModule", () => {
  it("creates the managed handoff before starting and exposes its readiness", async () => {
    const events: string[] = [];
    const ctx = {
      config: {},
      stateDir: "test",
      logger: console,
      lifecycleMode: "externally-managed" as const,
      handoffVersion: 2 as const,
    };
    const handoff = {
      version: 2 as const,
      drainPhase: "execution" as const,
      pause: async () => {},
      resume: async () => {},
      isReady: () => true,
    };
    const stop = vi.fn(async () => {});
    const handle = await startLazyPluginServiceModule({
      loadDefaultModule: async () => ({
        createHandoff: () => {
          events.push("standby");
          return handoff;
        },
        start: async () => {
          events.push("start");
        },
        stop,
      }),
      startExportNames: ["start"],
      stopExportNames: ["stop"],
      handoffExportName: "createHandoff",
      serviceContext: ctx,
    });
    expect(events).toEqual(["standby", "start"]);
    expect(handle?.handoff?.isReady(ctx)).toBe(true);
    await handle?.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("cleans up partial initialization without hiding either failure", async () => {
    const stop = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    await expect(
      startLazyPluginServiceModule({
        loadDefaultModule: async () => ({
          start: async () => {
            throw new Error("start failed");
          },
          stop,
        }),
        startExportNames: ["start"],
        stopExportNames: ["stop"],
      }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "start failed" }),
        expect.objectContaining({ message: "cleanup failed" }),
      ],
    });
    expect(stop).toHaveBeenCalledOnce();
  });
  it("rejects managed modules without a lifecycle capability before starting", async () => {
    const start = vi.fn();
    await expect(
      startLazyPluginServiceModule({
        loadDefaultModule: async () => ({ start }),
        startExportNames: ["start"],
        handoffExportName: "createHandoff",
        serviceContext: {
          config: {},
          stateDir: "test",
          logger: console,
          lifecycleMode: "externally-managed",
          handoffVersion: 2,
        },
      }),
    ).rejects.toThrow("handoff");
    expect(start).not.toHaveBeenCalled();
  });
  afterEach(() => {
    delete process.env.OPENCLAW_LAZY_SERVICE_SKIP;
    delete process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE;
  });

  it("starts the default module and returns its stop hook", async () => {
    const lifecycle = createLazyModuleLifecycle();

    const handle = await expectLifecycleStarted({
      loadDefaultModule: async () => lifecycle.module,
      startExportNames: ["startDefault"],
      stopExportNames: ["stopDefault"],
    });

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(handle).not.toBeNull();
    await handle?.stop();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it("honors skip env before loading the module", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_SKIP = "1";
    const loadDefaultModule = vi.fn(async () => createLazyModuleLifecycle().module);

    const handle = await startLazyPluginServiceModule({
      skipEnvVar: "OPENCLAW_LAZY_SERVICE_SKIP",
      loadDefaultModule,
      startExportNames: ["startDefault"],
    });

    expect(handle).toBeNull();
    expect(loadDefaultModule).not.toHaveBeenCalled();
  });

  it("uses the override module when configured", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "virtual:service";
    const start = createAsyncHookMock();
    const loadOverrideModule = vi.fn(async () => ({ startOverride: start }));

    await expectLifecycleStarted({
      overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
      loadDefaultModule: async () => ({ startDefault: createAsyncHookMock() }),
      loadOverrideModule,
      startExportNames: ["startOverride", "startDefault"],
    });

    expect(loadOverrideModule).toHaveBeenCalledWith("virtual:service");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("validates the override specifier before loading it", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "virtual:service";
    const loadOverrideModule = vi.fn(async () => ({ startOverride: createAsyncHookMock() }));
    const validateOverrideSpecifier = vi.fn((specifier: string) => `validated:${specifier}`);

    await expectLifecycleStarted({
      overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
      validateOverrideSpecifier,
      loadOverrideModule,
      startExportNames: ["startOverride"],
    });

    expect(validateOverrideSpecifier).toHaveBeenCalledWith("virtual:service");
    expect(loadOverrideModule).toHaveBeenCalledWith("validated:virtual:service");
  });

  it("surfaces override validation failures", async () => {
    process.env.OPENCLAW_LAZY_SERVICE_OVERRIDE = "data:text/javascript,boom";

    await expect(
      expectLifecycleStarted({
        overrideEnvVar: "OPENCLAW_LAZY_SERVICE_OVERRIDE",
        validateOverrideSpecifier: () => {
          throw new Error("blocked override");
        },
        startExportNames: ["startDefault"],
      }),
    ).rejects.toThrow("blocked override");
  });
});
