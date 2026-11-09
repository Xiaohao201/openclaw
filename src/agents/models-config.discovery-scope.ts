import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Narrow managed startup discovery only when model references are unambiguous. */
export function collectConfiguredDiscoveryProviders(config?: OpenClawConfig): string[] | undefined {
  if (!config) {
    return undefined;
  }
  const providers = new Set(Object.keys(config.models?.providers ?? {}));
  const catalog = config.agents?.defaults?.models ?? {};
  let unresolved = false;
  const addRef = (value: string | undefined) => {
    let ref = value?.trim();
    if (!ref) {
      return;
    }
    if (!ref.includes("/")) {
      const aliases = Object.entries(catalog).filter(([, entry]) => entry.alias === ref);
      if (aliases.length !== 1) {
        unresolved = true;
        return;
      }
      ref = aliases[0][0];
    }
    const slash = ref.indexOf("/");
    if (slash <= 0) {
      unresolved = true;
      return;
    }
    providers.add(ref.slice(0, slash));
  };
  const addModel = (model: AgentModelConfig | undefined) => {
    if (typeof model === "string") {
      addRef(model);
    } else if (model) {
      addRef(model.primary);
      model.fallbacks?.forEach(addRef);
    }
  };
  for (const agent of [config.agents?.defaults, ...(config.agents?.list ?? [])]) {
    addModel(agent?.model);
    addModel(agent?.subagents?.model);
    addRef(agent?.heartbeat?.model);
  }
  const defaults = config.agents?.defaults;
  for (const model of [
    defaults?.imageModel,
    defaults?.pdfModel,
    defaults?.imageGenerationModel,
    defaults?.videoGenerationModel,
    defaults?.musicGenerationModel,
  ]) {
    addModel(model);
  }
  Object.keys(catalog).forEach(addRef);
  for (const profile of Object.values(config.auth?.profiles ?? {})) {
    providers.add(profile.provider);
  }
  addRef(config.hooks?.gmail?.model);
  config.hooks?.mappings?.forEach((mapping) => addRef(mapping.model));
  addModel(config.tools?.subagents?.model);
  const media = config.tools?.media;
  for (const selection of [media, media?.image, media?.audio, media?.video]) {
    for (const model of selection?.models ?? []) {
      if (model.type === "cli") {
        continue;
      }
      if (model.provider) {
        providers.add(model.provider);
      } else {
        addRef(model.model);
      }
    }
  }
  // Preserve broad discovery for unqualified model names and unconfigured setups.
  return !unresolved && providers.size > 0 ? [...providers].toSorted() : undefined;
}
