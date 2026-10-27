import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

export default definePluginEntry({
  id: "legal-check",
  name: "Legal Check",
  description:
    "Legacy legal-check compatibility service. Agent-facing system-detection tools are disabled.",
  register(api: OpenClawPluginApi) {
    api.registerService({
      id: "legal-check",
      // This service owns no ingress; core drains the agent turns using its tools.
      handoff: { version: 1, pause: async () => {}, resume: async () => {}, isReady: () => true },
      start(ctx) {
        ctx.logger.info("[LEGAL_CHECK] Legacy agent tools disabled");
      },
      stop(ctx) {
        ctx.logger.info("[LEGAL_CHECK] Service stopped");
      },
    });
  },
});
