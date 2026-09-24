import { z } from "zod";
import type { PluginRuntime } from "../api.js";

type RunArgs = Parameters<PluginRuntime["subagent"]["run"]>[0];
type Message = {
  message: string;
  useMemory?: boolean;
  templateId?: number;
  skillIds?: number[];
  builtinSkillName?: string;
  hasAttachment?: boolean;
  attachments?: unknown[];
};
type TurnState = { request: string; history: unknown[]; allowMemory: boolean };
const decisionSchema = z.object({
  version: z.literal(1),
  route: z.enum([
    "answer",
    "clarify",
    "read",
    "search",
    "memory",
    "query",
    "check",
    "report",
    "write",
    "think",
    "schedule",
    "uncertain",
  ]),
  confidence: z.number().finite().min(0).max(1),
});
// Display categories are not permission groups: never derive this from TOOL_CATEGORIES.
const readOnlyTools = {
  read: ["read"],
  search: ["web_fetch", "web_search"],
  memory: ["memory_get", "memory_search"],
} as const;

export function createTurnRouteTransform(deps: {
  message: Message;
  history: (params: { sessionKey: string; limit: number }) => Promise<{ messages: unknown[] }>;
  decide: (state: TurnState) => Promise<unknown>;
}) {
  let decision: Promise<z.infer<typeof decisionSchema> | undefined> | undefined;
  return async (args: RunArgs): Promise<RunArgs> => {
    const msg = deps.message;
    if (
      !msg.message.includes("[JEV_SYNTHETIC_BENCH]") ||
      msg.templateId ||
      msg.builtinSkillName ||
      msg.skillIds?.length ||
      msg.hasAttachment ||
      msg.attachments?.length ||
      args.skillFilter?.length ||
      args.disableTools
    ) {
      return args;
    }
    // Cache within this runner/turn only, never across users, sessions, or turns.
    decision ??= (async () => {
      try {
        const history = await deps.history({ sessionKey: args.sessionKey, limit: 101 });
        if (history.messages.length > 100) {
          return undefined;
        }
        const messages = history.messages.filter((entry) => {
          const parsed = z.object({ role: z.string() }).safeParse(entry);
          return (
            parsed.success && ["user", "assistant", "tool", "toolResult"].includes(parsed.data.role)
          );
        });
        const state = {
          request: msg.message,
          history: messages,
          allowMemory: msg.useMemory !== false,
        };
        if (JSON.stringify(state).length > 20000) {
          return undefined;
        }
        const result = decisionSchema.safeParse(await deps.decide(state));
        return result.success && result.data.confidence >= 0.8 ? result.data : undefined;
      } catch {
        return undefined;
      }
    })();
    const selected = await decision;
    if (!selected || selected.route === "uncertain") {
      return args;
    }
    if (selected.route === "answer" || selected.route === "clarify") {
      return {
        ...args,
        disableTools: true,
        ...(selected.route === "clarify"
          ? {
              extraSystemPrompt: [
                args.extraSystemPrompt,
                "The request needs clarification. Ask the user for the missing information before taking action. Do not invent missing facts.",
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
      };
    }
    if (selected.route !== "read" && selected.route !== "search" && selected.route !== "memory") {
      return args;
    }
    if (selected.route === "memory" && msg.useMemory === false) {
      return args;
    }
    const toolsAllow = readOnlyTools[selected.route].filter(
      (name) => !args.toolsAllow?.length || args.toolsAllow.includes(name),
    );
    // Empty toolsAllow means unrestricted in the host API, so use disableTools explicitly.
    return toolsAllow.length ? { ...args, toolsAllow } : { ...args, disableTools: true };
  };
}

/** This optional loopback endpoint is supplied only by the synthetic debug launcher. */
export function createLocalTurnDecider(endpoint: string | undefined) {
  if (!endpoint) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/turn-decision")
  ) {
    return undefined;
  }
  return async (state: TurnState): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return response.json();
  };
}
