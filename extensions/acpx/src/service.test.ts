import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
}));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
  registerAcpRuntimeBackend: (entry: { id: string; runtime: unknown; healthy?: () => boolean }) => {
    runtimeRegistry.set(entry.id, entry);
  },
  unregisterAcpRuntimeBackend: (id: string) => {
    runtimeRegistry.delete(id);
  },
}));

vi.mock("./runtime.js", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: function AcpxRuntime() {},
  createAgentRegistry: vi.fn(() => ({})),
  createFileSessionStore: vi.fn(() => ({})),
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import { createAcpxRuntimeService } from "./service.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  runtimeRegistry.clear();
  delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
  delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function createServiceContext(workspaceDir: string) {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, ".openclaw-plugin-state"),
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("createAcpxRuntimeService", () => {
  it.each(["unhealthy", "failed-probe", "skipped-probe"])(
    "fails managed readiness for %s",
    async (scenario) => {
      if (scenario === "skipped-probe") {
        process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE = "1";
      }
      const workspaceDir = await makeTempDir();
      const ctx = {
        ...createServiceContext(workspaceDir),
        lifecycleMode: "externally-managed" as const,
        handoffVersion: 2 as const,
      };
      const service = createAcpxRuntimeService({
        pluginConfig: { stateDir: path.join(workspaceDir, "state") },
        runtimeFactory: () =>
          ({
            ensureSession: vi.fn(),
            runTurn: vi.fn(),
            close: vi.fn(),
            cancel: vi.fn(),
            isHealthy: () => false,
            probeAvailability: async () => {
              if (scenario === "failed-probe") {
                throw new Error("probe failed");
              }
            },
            doctor: async () => ({
              ok: false,
              message: "missing fixture backend",
              details: ["not available"],
            }),
          }) as never,
      });
      await expect(service.start(ctx)).rejects.toThrow();
      expect(service.handoff!.isReady(ctx)).toBe(false);
      await expect(service.handoff!.resume(ctx)).rejects.toThrow("not ready");
      await service.stop!(ctx);
      expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    },
  );
  it("starts managed backends in standby and drains a running stream", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = {
      ...createServiceContext(workspaceDir),
      lifecycleMode: "externally-managed" as const,
      handoffVersion: 2 as const,
    };
    const finish = createDeferred<void>();
    const runtime = {
      ensureSession: vi.fn(async () => ({
        sessionKey: "test",
        backend: "acpx",
        runtimeSessionName: "test",
      })),
      async *runTurn() {
        yield { type: "text_delta" as const, text: "started" };
        await finish.promise;
      },
      cancel: vi.fn(),
      close: vi.fn(),
      probeAvailability: vi.fn(async () => {}),
      isHealthy: () => true,
    };
    const service = createAcpxRuntimeService({
      pluginConfig: { stateDir: path.join(workspaceDir, "state") },
      runtimeFactory: () => runtime,
    });
    await service.start(ctx);
    const backend = getAcpRuntimeBackend("acpx")!.runtime;
    const input = { sessionKey: "test", agent: "test", mode: "persistent" as const };
    await expect(backend.ensureSession(input)).rejects.toThrow("not accepting");
    expect(service.handoff!.isReady(ctx)).toBe(true);
    await service.handoff!.resume(ctx);
    const handle = await backend.ensureSession(input);
    const stream = backend.runTurn({ handle, text: "hello", mode: "prompt", requestId: "test" });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await expect(service.handoff!.pause(ctx, 5)).rejects.toThrow("active");
    expect(runtime.cancel).not.toHaveBeenCalled();
    finish.resolve(undefined);
    await iterator.next();
    await service.handoff!.pause(ctx, 100);
    await service.stop!(ctx);
  });
  it("registers and unregisters the embedded backend", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      ensureSession: vi.fn(),
      runTurn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      probeAvailability: vi.fn(async () => {}),
      isHealthy: vi.fn(() => true),
      doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    };
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(ctx);

    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
  });

  it("creates the embedded runtime state directory before probing", async () => {
    const workspaceDir = await makeTempDir();
    const stateDir = path.join(workspaceDir, "custom-state");
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {
      await fs.access(stateDir);
    });
    const service = createAcpxRuntimeService({
      pluginConfig: { stateDir },
      runtimeFactory: () =>
        ({
          ensureSession: vi.fn(),
          runTurn: vi.fn(),
          cancel: vi.fn(),
          close: vi.fn(),
          probeAvailability,
          isHealthy: () => true,
          doctor: async () => ({ ok: true, message: "ok" }),
        }) as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("passes the default runtime timeout to the embedded runtime factory", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      ensureSession: vi.fn(),
      runTurn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      probeAvailability: vi.fn(async () => {}),
      isHealthy: vi.fn(() => true),
      doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    };
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService({
      runtimeFactory,
    });

    await service.start(ctx);

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginConfig: expect.objectContaining({
          timeoutSeconds: 120,
        }),
      }),
    );

    await service.stop?.(ctx);
  });

  it("warns when legacy compatibility config is explicitly ignored", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      ensureSession: vi.fn(),
      runTurn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      probeAvailability: vi.fn(async () => {}),
      isHealthy: vi.fn(() => true),
      doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    };
    const service = createAcpxRuntimeService({
      pluginConfig: {
        queueOwnerTtlSeconds: 30,
        strictWindowsCmdWrapper: false,
      },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "embedded acpx runtime ignores legacy compatibility config: queueOwnerTtlSeconds, strictWindowsCmdWrapper=false",
      ),
    );

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime probe via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE = "1";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const service = createAcpxRuntimeService({
      runtimeFactory: () =>
        ({
          ensureSession: vi.fn(),
          runTurn: vi.fn(),
          cancel: vi.fn(),
          close: vi.fn(),
          probeAvailability,
          isHealthy: () => false,
          doctor: async () => ({ ok: false, message: "nope" }),
        }) as never,
    });

    await service.start(ctx);

    expect(probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeTruthy();

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime backend via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = "1";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime factory should not run when ACPX is skipped");
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: runtimeFactory as never,
    });

    await service.start(ctx);

    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});
