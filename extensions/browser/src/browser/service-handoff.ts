import {
  createServiceWorkTracker,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/service-runtime";

let managed = process.env.OPENCLAW_EXTERNAL_LIFECYCLE === "1";
let initialized = false;
export const browserServiceWork = createServiceWorkTracker("browser-control", !managed);
export const isBrowserControlManaged = () => managed;
export const markBrowserControlInitialized = () => {
  initialized = true;
};
export const markBrowserControlStopped = () => {
  initialized = false;
};

export function createBrowserControlHandoff(
  ctx: OpenClawPluginServiceContext,
): NonNullable<OpenClawPluginService["handoff"]> {
  if (ctx.handoffVersion !== 2) {
    throw new Error("browser-control requires a host with handoff v2 support");
  }
  managed = true;
  initialized = false;
  browserServiceWork.closeAdmission();
  return {
    version: 2,
    drainPhase: "execution",
    isReady: () => initialized,
    pause: async (_ctx, timeoutMs) => browserServiceWork.pause(timeoutMs),
    resume: async () => {
      if (!initialized) {
        throw new Error("browser-control is not initialized");
      }
      browserServiceWork.resume();
    },
  };
}
