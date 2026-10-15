import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  collectBrowserSecurityAuditFindings,
  createBrowserPluginService,
  createBrowserTool,
  handleBrowserGatewayRequest,
  registerBrowserCli,
  runBrowserProxyCommand,
} from "./register.runtime.js";

// Profiles reconcile on each browser request. Other browser settings retain the
// gateway's default restart behavior for unclaimed configuration paths.
export const browserPluginReload = { hotPrefixes: ["browser.profiles"] };

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "browser.proxy",
    cap: "browser",
    handle: runBrowserProxyCommand,
  },
];

export const browserSecurityAuditCollectors = [collectBrowserSecurityAuditFindings];

export function registerBrowserPlugin(api: OpenClawPluginApi) {
  api.registerTool(((ctx: OpenClawPluginToolContext) =>
    createBrowserTool({
      sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
      allowHostControl: ctx.browser?.allowHostControl,
      agentSessionKey: ctx.sessionKey,
    })) as OpenClawPluginToolFactory);
  api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] });
  api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
    scope: "operator.write",
  });
  api.registerService(createBrowserPluginService());
}
