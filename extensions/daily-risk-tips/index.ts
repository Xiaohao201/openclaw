import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createDailyRiskTipsToolFactory } from "./src/daily-risk-tips-tool.js";

export default definePluginEntry({
  id: "daily-risk-tips",
  name: "Daily Risk Tips",
  description:
    "每日风险提示生成工具：检索 Milvus 中人工审核定稿的历史范例，提炼写作规则后生成一条符合" +
    "深圳市网信办撰写规范的新风险提示（≤150字）。",
  register(api: OpenClawPluginApi) {
    api.registerTool(createDailyRiskTipsToolFactory(api), { name: "daily_risk_tips" });

    api.registerService({
      id: "daily-risk-tips",
      // This service owns no ingress; core drains the agent turns using its tools.
      handoff: { version: 1, pause: async () => {}, resume: async () => {}, isReady: () => true },
      start(ctx) {
        ctx.logger.info("[DAILY_RISK_TIPS] Service initialized");
      },
      stop(ctx) {
        ctx.logger.info("[DAILY_RISK_TIPS] Service stopped");
      },
    });
  },
});
