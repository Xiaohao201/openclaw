import { stopOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";
import { isBrowserControlManaged } from "./service-handoff.js";

export async function ensureExtensionRelayForProfiles(_params: {
  resolved: ResolvedBrowserConfig;
  onWarn: (message: string) => void;
}) {
  // Intentional no-op: the Chrome extension relay path has been removed.
  // runtime-lifecycle still calls this helper, so keep the stub until the next
  // breaking cleanup rather than changing the call graph in a patch release.
}

export async function stopKnownBrowserProfiles(params: {
  getState: () => BrowserServerState | null;
  onWarn: (message: string) => void;
}) {
  const current = params.getState();
  if (!current) {
    return;
  }
  const ctx = createBrowserRouteContext({
    getState: params.getState,
    refreshConfigFromDisk: true,
  });
  const failures: unknown[] = [];
  try {
    for (const name of listKnownProfileNames(current)) {
      try {
        const runtime = current.profiles.get(name);
        if (runtime?.running) {
          await stopOpenClawChrome(runtime.running);
          if (isBrowserControlManaged()) {
            const proc = runtime.running.proc;
            const deadline = performance.now() + 5000;
            while (proc.exitCode === null && proc.signalCode === null) {
              if (performance.now() >= deadline) {
                throw new Error(`Browser profile ${name} did not exit after shutdown`);
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          runtime.running = null;
          continue;
        }
        await ctx.forProfile(name).stopRunningBrowser();
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (err) {
    if (isBrowserControlManaged()) {
      throw err;
    }
    params.onWarn(`openclaw browser stop failed: ${String(err)}`);
  }
  if (isBrowserControlManaged() && failures.length) {
    throw new AggregateError(failures, "Browser profiles did not stop cleanly");
  }
}
