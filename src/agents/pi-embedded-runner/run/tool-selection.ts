/** Per-run restrictions apply to every tool source without changing agent policy. */
export function createRunToolSelection(params: {
  modelSupportsTools: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}) {
  const enabled = params.modelSupportsTools && !params.disableTools;
  const allow = params.toolsAllow?.length ? new Set(params.toolsAllow) : undefined;
  return {
    enabled,
    filter<T>(tools: T[], name: (tool: T) => string): T[] {
      if (!enabled) {
        return [];
      }
      return allow ? tools.filter((tool) => allow.has(name(tool))) : tools;
    },
  };
}
