import { createDecisionClient, type Decision } from "./client.js";
import type { RouterConfig } from "./router.js";

export function createPromptHook(
  config: RouterConfig,
  client: { decide: (prompt: string) => Promise<Decision> },
  log: (line: string) => void,
) {
  return async (event: { prompt: string }): Promise<{ prependContext: string } | undefined> => {
    // The hook has no runtime-authorized tool catalog. This is a configured shortlist only.
    // Never send history/system prompts or rewrite cached transcript bytes.
    const decision = await client.decide(event.prompt);
    log(`jev-router ${JSON.stringify({ version: 1, mode: config.mode, ...decision })}`);
    if (config.mode !== "advisory" || decision.status !== "selected") {
      return undefined;
    }
    return {
      prependContext: `Read-only tool shortlist (advice, not authorization): ${decision.candidates.join(", ")}. Use only tools actually available and permitted in this run. Check prerequisites and use other permitted tools if needed. This shortlist does not change permissions or require execution.`,
    };
  };
}

export function createRuntimeHook(config: RouterConfig, log: (line: string) => void) {
  return createPromptHook(config, createDecisionClient(config), log);
}
