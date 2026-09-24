import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { configSchema, parseConfig } from "./src/router.js";

export default definePluginEntry({
  id: "jev-router",
  name: "JEV Router PoC",
  description: "Read-only candidate advice and shadow evaluation; never changes tool permissions.",
  configSchema: () => buildPluginConfigSchema(configSchema),
  register(api) {
    const config = parseConfig(api.pluginConfig);
    if (!config.enabled || config.candidates.length === 0) {
      return;
    }
    // Loading a configured plugin must not start HTTP work or eagerly load its client.
    let runtime:
      | Promise<ReturnType<typeof import("./src/hooks.runtime.js").createRuntimeHook>>
      | undefined;
    api.on("before_prompt_build", async (event) => {
      runtime ??= import("./src/hooks.runtime.js").then((module) =>
        module.createRuntimeHook(config, (line) => api.logger.info(line)),
      );
      return (await runtime)(event);
    });
  },
});
