import type { BrowserAssistanceSessionOptions } from "../../extensions/browser/api.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

export type {
  BrowserAssistanceControl,
  BrowserAssistanceFrame,
  BrowserAssistanceNotice,
  BrowserAssistanceSessionOptions,
} from "../../extensions/browser/api.js";

/** Version 1: opt one trusted execution session into isolated, bounded human browser assistance. */
export function registerBrowserAssistanceSession(
  options: BrowserAssistanceSessionOptions,
): () => Promise<void> {
  const facade = loadActivatedBundledPluginPublicSurfaceModuleSync<{
    registerBrowserAssistanceSession(options: BrowserAssistanceSessionOptions): () => Promise<void>;
  }>({ dirName: "browser", artifactBasename: "runtime-api.js" });
  return facade.registerBrowserAssistanceSession(options);
}
