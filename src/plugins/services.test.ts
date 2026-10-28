import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  child: vi.fn(() => mockedLogger),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

import { STATE_DIR } from "../config/paths.js";
import { startPluginServices } from "./services.js";

describe("service handoff v1", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("validates all managed contracts before starting any service", async () => {
    vi.stubEnv("OPENCLAW_EXTERNAL_LIFECYCLE", "1");
    const start = vi.fn();
    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "valid",
          start,
          handoff: {
            version: 1,
            pause: async () => {},
            resume: async () => {},
            isReady: () => true,
          },
        },
        { id: "legacy", start },
      ]),
      config: {},
    });
    expect(() => handle.assertHealthy?.()).toThrow("legacy");
    expect(handle.handoff!.isReady()).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it("announces phase support to managed services", async () => {
    vi.stubEnv("OPENCLAW_EXTERNAL_LIFECYCLE", "1");
    const start = vi.fn();
    await startPluginServices({
      registry: createRegistry([
        {
          id: "service",
          start,
          handoff: {
            version: 2,
            drainPhase: "execution",
            pause: async () => {},
            resume: async () => {},
            isReady: () => true,
          },
        },
      ]),
      config: {},
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleMode: "externally-managed", handoffVersion: 2 }),
    );
  });
  it("keeps execution services available until ingress has drained and resumes them first", async () => {
    const events: string[] = [];
    let accepting = true;
    const backend: OpenClawPluginService = {
      id: "backend",
      start() {},
      handoff: {
        version: 2,
        drainPhase: "execution",
        pause: async () => {
          accepting = false;
          events.push("backend paused");
        },
        resume: async () => {
          accepting = true;
          events.push("backend resumed");
        },
        isReady: () => true,
      },
    };
    const ingress: OpenClawPluginService = {
      id: "ingress",
      start() {},
      handoff: {
        version: 1,
        pause: async () => {
          expect(accepting).toBe(true);
          events.push("accepted task finished");
        },
        resume: async () => {
          expect(accepting).toBe(true);
          events.push("ingress resumed");
        },
        isReady: () => true,
      },
    };
    const handle = await startPluginServices({
      registry: createRegistry([ingress, backend]),
      config: {},
    });
    await handle.handoff!.pause(100);
    expect(accepting).toBe(true);
    await handle.handoff!.pauseExecution!(100);
    await handle.handoff!.resume();
    expect(events).toEqual([
      "accepted task finished",
      "backend paused",
      "backend resumed",
      "ingress resumed",
    ]);
  });
  it("refuses to drain services without a handoff contract", async () => {
    const handle = await startPluginServices({
      registry: createRegistry([{ id: "legacy", start() {} }]),
      config: {},
    });
    await expect(handle.handoff!.pause(100)).rejects.toThrow("legacy");
  });

  it("waits for every pause before reporting a failure and supports resume", async () => {
    const resume = vi.fn(async () => {});
    const service: OpenClawPluginService = {
      id: "test",
      start() {},
      handoff: {
        version: 1,
        pause: async () => {
          throw new Error("busy");
        },
        resume,
        isReady: () => true,
      },
    };
    const handle = await startPluginServices({ registry: createRegistry([service]), config: {} });
    expect(handle.handoff!.isReady()).toBe(true);
    await expect(handle.handoff!.pause(100)).rejects.toThrow("Service drain failed");
    await handle.handoff!.resume();
    expect(resume).toHaveBeenCalledOnce();
  });
});

function createRegistry(services: OpenClawPluginService[]) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) => ({
    pluginId: "plugin:test",
    service,
    source: "test",
    rootDir: "/plugins/test-plugin",
  })) as typeof registry.services;
  return registry;
}

function createServiceConfig() {
  return {} as Parameters<typeof startPluginServices>[0]["config"];
}

function expectServiceContext(
  ctx: OpenClawPluginServiceContext,
  config: Parameters<typeof startPluginServices>[0]["config"],
) {
  expect(ctx.config).toBe(config);
  expect(ctx.workspaceDir).toBe("/tmp/workspace");
  expect(ctx.stateDir).toBe(STATE_DIR);
  expectServiceLogger(ctx);
}

function expectServiceLogger(ctx: OpenClawPluginServiceContext) {
  expect(ctx.logger).toBeDefined();
  expect(typeof ctx.logger.info).toBe("function");
  expect(typeof ctx.logger.warn).toBe("function");
  expect(typeof ctx.logger.error).toBe("function");
}

function expectServiceContexts(
  contexts: OpenClawPluginServiceContext[],
  config: Parameters<typeof startPluginServices>[0]["config"],
) {
  expect(contexts).not.toHaveLength(0);
  contexts.forEach((ctx) => {
    expectServiceContext(ctx, config);
  });
}

function expectServiceLifecycleState(params: {
  starts: string[];
  stops: string[];
  contexts: OpenClawPluginServiceContext[];
  config: Parameters<typeof startPluginServices>[0]["config"];
}) {
  expect(params.starts).toEqual(["a", "b", "c"]);
  expect(params.stops).toEqual(["c", "a"]);
  expect(params.contexts).toHaveLength(3);
  expectServiceContexts(params.contexts, params.config);
}

async function startTrackingServices(params: {
  services: OpenClawPluginService[];
  config?: Parameters<typeof startPluginServices>[0]["config"];
  workspaceDir?: string;
}) {
  return startPluginServices({
    registry: createRegistry(params.services),
    config: params.config ?? createServiceConfig(),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

function createTrackingService(
  id: string,
  params: {
    starts?: string[];
    stops?: string[];
    contexts?: OpenClawPluginServiceContext[];
    failOnStart?: boolean;
    failOnStop?: boolean;
    stopSpy?: () => void;
  } = {},
): OpenClawPluginService {
  return {
    id,
    start: (ctx) => {
      if (params.failOnStart) {
        throw new Error("start failed");
      }
      params.starts?.push(id.at(-1) ?? id);
      params.contexts?.push(ctx);
    },
    stop: params.stopSpy
      ? () => {
          params.stopSpy?.();
        }
      : params.stops || params.failOnStop
        ? () => {
            if (params.failOnStop) {
              throw new Error("stop failed");
            }
            params.stops?.push(id.at(-1) ?? id);
          }
        : undefined,
  };
}

describe("startPluginServices", () => {
  it("retains strict drain failures and stops each service only once", async () => {
    const stop = vi.fn(async () => {
      throw new Error("still owns work");
    });
    const handle = await startTrackingServices({
      services: [{ id: "test", start: () => {}, stop }],
    });
    await handle.stop();
    await expect(handle.stop({ strict: true })).rejects.toThrow("did not stop cleanly");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reports startup failures and cleans up partially started services", async () => {
    const stop = vi.fn();
    const handle = await startTrackingServices({
      services: [
        {
          id: "test",
          start: () => {
            throw new Error("failed");
          },
          stop,
        },
      ],
    });
    expect(() => handle.assertHealthy?.()).toThrow("startup failed");
    await handle.stop({ strict: true });
    expect(stop).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts services and stops them in reverse order", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const contexts: OpenClawPluginServiceContext[] = [];

    const config = createServiceConfig();
    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-a", { starts, stops, contexts }),
        createTrackingService("service-b", { starts, contexts }),
        createTrackingService("service-c", { starts, stops, contexts }),
      ],
      config,
      workspaceDir: "/tmp/workspace",
    });
    await handle.stop();

    expectServiceLifecycleState({ starts, stops, contexts, config });
  });

  it("logs start/stop failures and continues", async () => {
    const stopOk = vi.fn();
    const stopThrows = vi.fn(() => {
      throw new Error("stop failed");
    });

    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-start-fail", {
          failOnStart: true,
          stopSpy: vi.fn(),
        }),
        createTrackingService("service-ok", { stopSpy: stopOk }),
        createTrackingService("service-stop-fail", { stopSpy: stopThrows }),
      ],
    });

    await handle.stop();

    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "plugin service failed (service-start-fail, plugin=plugin:test, root=/plugins/test-plugin):",
      ),
    );
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("plugin service stop failed (service-stop-fail):"),
    );
    expect(stopOk).toHaveBeenCalledOnce();
    expect(stopThrows).toHaveBeenCalledOnce();
  });
});
