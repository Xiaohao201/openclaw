// Public gateway/client helpers for plugins that talk to the host gateway surface.

import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";

/** Returns a copy of this request's operator scopes; outside a request, deny by default. */
export function getCurrentGatewayOperatorScopes(): readonly string[] {
  return [...(getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [])];
}

export * from "../gateway/channel-status-patches.js";
export { GatewayClient } from "../gateway/client.js";
export {
  createOperatorApprovalsGatewayClient,
  withOperatorApprovalsGatewayClient,
} from "../gateway/operator-approvals-client.js";
export type { EventFrame } from "../gateway/protocol/index.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
