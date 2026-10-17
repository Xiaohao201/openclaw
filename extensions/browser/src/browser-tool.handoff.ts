import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "./core-api.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Transport-neutral page identity: Chrome MCP page numbers are not CDP target IDs. */
export function withSessionBrowserHandoff(
  tool: AnyAgentTool,
  enabled: boolean,
  mark: (profile: string | undefined, targetId: string, fn: string) => Promise<unknown>,
): AnyAgentTool {
  if (!enabled) {
    return tool;
  }
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (...args) => {
      const result = await execute(...args);
      const params = record(args[1]);
      const details = record(result.details);
      // Only explicit local-host operations are eligible; node/sandbox routing is never inferred.
      if (
        params?.target !== "host" ||
        params.node ||
        record(result)?.isError ||
        !["open", "focus", "snapshot", "navigate", "act", "screenshot"].includes(
          String(params.action),
        )
      ) {
        return result;
      }
      const targetId = details?.targetId ?? params.targetId ?? record(params.request)?.targetId;
      if (typeof targetId !== "string") {
        return result;
      }
      const marker = randomUUID();
      try {
        await mark(
          typeof params.profile === "string" ? params.profile : undefined,
          targetId,
          `() => { Object.defineProperty(window, "__openclaw_session_handoff_v1", {value: ${JSON.stringify(marker)}, configurable: true}); return true; }`,
        );
        return {
          ...result,
          details: { ...details, targetId, sessionHandoff: { version: 1, marker } },
        };
      } catch {
        // Evaluation-disabled, stale, or closed tabs cannot be handed to another executor.
        return { ...result, details: { ...details, sessionHandoff: null } };
      }
    },
  };
}
