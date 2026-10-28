import { createServiceWorkTracker } from "openclaw/plugin-sdk/service-runtime";
import type { AcpRuntime } from "../runtime-api.js";

/** Keep OpenClaw admission separate from the upstream ACP runtime implementation. */
export function createManagedAcpRuntime(runtime: AcpRuntime) {
  const work = createServiceWorkTracker("acpx-runtime");
  const preparedSessions = new Set<string>();
  const wrapped: AcpRuntime = {
    ensureSession: (input) =>
      work.run(async () => {
        const handle = await runtime.ensureSession(input);
        if (input.mode === "persistent") {
          preparedSessions.add(handle.sessionKey);
        }
        return handle;
      }),
    runTurn: (input) =>
      work.stream(async function* () {
        yield* runtime.runTurn(input);
        preparedSessions.delete(input.handle.sessionKey);
      }),
    cancel: (input) => work.run(() => runtime.cancel(input)),
    close: (input) =>
      work.run(async () => {
        await runtime.close(input);
        if (input.discardPersistentState) {
          preparedSessions.delete(input.handle.sessionKey);
        }
      }),
    ...(runtime.getCapabilities
      ? {
          getCapabilities: (input: Parameters<NonNullable<AcpRuntime["getCapabilities"]>>[0]) =>
            work.run(async () => runtime.getCapabilities!(input)),
        }
      : {}),
    ...(runtime.getStatus
      ? {
          getStatus: (input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0]) =>
            work.run(() => runtime.getStatus!(input)),
        }
      : {}),
    ...(runtime.setMode
      ? {
          setMode: (input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]) =>
            work.run(() => runtime.setMode!(input)),
        }
      : {}),
    ...(runtime.setConfigOption
      ? {
          setConfigOption: (input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]) =>
            work.run(() => runtime.setConfigOption!(input)),
        }
      : {}),
    ...(runtime.prepareFreshSession
      ? {
          prepareFreshSession: (input: { sessionKey: string }) =>
            work.run(() => runtime.prepareFreshSession!(input)),
        }
      : {}),
    ...(runtime.doctor ? { doctor: () => work.run(() => runtime.doctor!()) } : {}),
  };
  return {
    runtime: wrapped,
    work,
    pause: async (timeoutMs: number) => {
      await work.pause(timeoutMs);
      // acpx 0.5.3 retains a client after ensureSession, but exposes no
      // non-destructive disposal API. Refuse retirement instead of orphaning it.
      if (preparedSessions.size) {
        throw new Error(
          `acpx-runtime: ${preparedSessions.size} prepared sessions have not completed a turn; safe disposal is unavailable`,
        );
      }
    },
  };
}
