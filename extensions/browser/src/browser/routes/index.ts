import type { BrowserRouteContext } from "../server-context.js";
import { browserServiceWork } from "../service-handoff.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";
import type { BrowserRouteHandler } from "./types.js";

export function registerBrowserRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // Wrap the actual handlers so a disconnected HTTP client cannot release a lease early.
  const wrap =
    (handler: BrowserRouteHandler): BrowserRouteHandler =>
    async (req, res) => {
      let entered = false;
      try {
        await browserServiceWork.run(async () => {
          entered = true;
          await handler(req, res);
        });
      } catch (error) {
        if (entered) {
          throw error;
        }
        res
          .status(503)
          .json({ error: "Browser control is paused for service handoff", code: "SERVICE_PAUSED" });
      }
    };
  const tracked: BrowserRouteRegistrar = {
    get: (path, handler) => app.get(path, wrap(handler)),
    post: (path, handler) => app.post(path, wrap(handler)),
    delete: (path, handler) => app.delete(path, wrap(handler)),
  };
  registerBrowserBasicRoutes(tracked, ctx);
  registerBrowserTabRoutes(tracked, ctx);
  registerBrowserAgentRoutes(tracked, ctx);
}
