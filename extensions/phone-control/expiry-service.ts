import {
  createServiceWorkTracker,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/service-runtime";

/** Reconcile expired grants before ingress resumes, and retain writes during drain. */
export function createPhoneControlExpiryService(
  checkExpiry: (ctx: OpenClawPluginServiceContext) => Promise<void>,
): OpenClawPluginService {
  const work = createServiceWorkTracker("phone-control-expiry");
  let context: OpenClawPluginServiceContext | undefined;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let failure: { cause: unknown } | undefined;

  const suspend = () => {
    polling = false;
    clearTimeout(timer);
    timer = undefined;
  };
  const assertSettled = () => {
    if (failure && context?.lifecycleMode) {
      throw new Error("phone-control-expiry: expiry check failed", { cause: failure.cause });
    }
  };
  const tick = (): Promise<void> => {
    if (pending) {
      return pending;
    }
    const ctx = context!;
    pending = work
      .run(() => checkExpiry(ctx))
      .then(() => {
        failure = undefined;
      })
      .catch((error: unknown) => {
        failure = { cause: error };
        ctx.logger.warn(`phone-control: expiry check failed: ${String(error)}`);
      })
      .finally(() => {
        pending = undefined;
        if (polling) {
          timer = setTimeout(() => {
            void tick();
          }, 15_000);
          timer.unref?.();
        }
      });
    return pending;
  };
  const resume = async () => {
    if (!context) {
      throw new Error("phone-control-expiry is not initialized");
    }
    if (polling) {
      await pending;
      assertSettled();
      return;
    }
    polling = true;
    work.resume();
    // A grant can expire while the worker is paused. Reconcile it before the
    // host resumes ingress, rather than waiting for the next polling interval.
    await tick();
    if (failure && context.lifecycleMode) {
      suspend();
      work.closeAdmission();
    }
    assertSettled();
  };
  const pause = async (timeoutMs: number) => {
    suspend();
    await work.pause(timeoutMs);
    await pending;
    assertSettled();
  };
  return {
    id: "phone-control-expiry",
    handoff: {
      version: 2,
      drainPhase: "execution",
      isReady: () => Boolean(context),
      pause: async (_ctx, timeoutMs) => pause(timeoutMs),
      resume: async () => resume(),
    },
    start: async (ctx) => {
      if (context) {
        return;
      }
      if (ctx.lifecycleMode && ctx.handoffVersion !== 2) {
        throw new Error("phone-control-expiry requires a host with handoff v2 support");
      }
      context = ctx;
      if (!ctx.lifecycleMode) {
        await resume();
      }
    },
    stop: async () => {
      await pause(30_000);
      context = undefined;
    },
  };
}
