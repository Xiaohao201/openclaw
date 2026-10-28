import {
  startLazyPluginServiceModule,
  type LazyPluginServiceHandle,
  type OpenClawPluginService,
} from "openclaw/plugin-sdk/browser-node-runtime";

type BrowserControlHandle = LazyPluginServiceHandle | null;
const UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER = /^(?:data|http|https|node):/i;

function validateBrowserControlOverrideSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER.test(trimmed)) {
    throw new Error(`Refusing unsafe browser control override specifier: ${trimmed}`);
  }
  return trimmed;
}

export function createBrowserPluginService(): OpenClawPluginService {
  let handle: BrowserControlHandle = null;
  let started = false;

  return {
    id: "browser-control",
    handoff: {
      version: 2,
      drainPhase: "execution",
      isReady: (ctx) => started && (handle?.handoff?.isReady(ctx) ?? true),
      pause: async (ctx, timeoutMs) => {
        await handle?.handoff?.pause(ctx, timeoutMs);
      },
      resume: async (ctx) => {
        if (!started) {
          throw new Error("browser-control is not initialized");
        }
        await handle?.handoff?.resume(ctx);
      },
    },
    start: async (ctx) => {
      if (started) {
        return;
      }
      if (ctx.lifecycleMode && ctx.handoffVersion !== 2) {
        throw new Error("browser-control requires a host with handoff v2 support");
      }
      handle = await startLazyPluginServiceModule({
        serviceContext: ctx,
        handoffExportName: "createBrowserControlHandoff",
        skipEnvVar: "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE",
        validateOverrideSpecifier: validateBrowserControlOverrideSpecifier,
        // Keep the default module import static so compiled builds still bundle it.
        loadDefaultModule: async () => await import("./server.js"),
        startExportNames: [
          "startBrowserControlServiceFromConfig",
          "startBrowserControlServerFromConfig",
        ],
        stopExportNames: ["stopBrowserControlService", "stopBrowserControlServer"],
      });
      started = true;
    },
    stop: async () => {
      const current = handle;
      if (!current) {
        started = false;
        return;
      }
      await current.stop();
      handle = null;
      started = false;
    },
  };
}
