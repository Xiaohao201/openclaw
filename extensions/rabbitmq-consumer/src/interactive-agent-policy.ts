import type { OpenClawPluginApi } from "../api.js";
import { isInactiveExecution, scopeExecutionTool } from "./active-execution.js";

/**
 * Interactive history rows currently own a single run, not a durable agent tree.
 * Keep delegated agent work out of this channel until completion delivery can
 * persist its originating history id and recover that binding after a restart.
 * Business jobs with their own delivery contracts are intentionally unaffected.
 */
export function registerInteractiveAgentPolicy(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, context) => {
    if (!context.sessionKey || !/^agent:[^:]+:rabbitmq:[^:]+:.+$/u.test(context.sessionKey)) {
      return undefined;
    }
    if (isInactiveExecution(context.sessionKey)) {
      return {
        block: true,
        blockReason:
          "This execution is no longer active. Do not start more tools or publish results.",
      };
    }
    const detachesWork =
      event.toolName === "sessions_spawn" ||
      event.toolName === "sessions_yield" ||
      event.toolName === "sessions_send" ||
      (event.toolName === "subagents" &&
        typeof event.params.action === "string" &&
        event.params.action.trim() === "steer");
    if (!detachesWork) {
      return scopeExecutionTool(context.sessionKey, event.toolName, event.params);
    }
    return {
      block: true,
      blockReason:
        "This interactive channel cannot deliver detached agent completions. " +
        "Continue the task in this run using the available search, file and other tools. " +
        "Do not delegate, yield, or promise a later automatic reply.",
    };
  });
}
