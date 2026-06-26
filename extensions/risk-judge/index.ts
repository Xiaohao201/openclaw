import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { MEDIA_WHITELIST_SIZE } from "./src/media-whitelist.js";
import { createRiskJudgeToolFactory } from "./src/risk-judge-tool.js";

export default definePluginEntry({
  id: "risk-judge",
  name: "Risk Judge",
  description:
    "舆情风险研判工具：套用标准化的 3 标准 / 5 级评级规则（蓝/黄/橙/红/高危预警）并结合权威媒体白名单，" +
    "调用当前配置的模型产出可复现的研判正文与处置建议。",
  register(api: OpenClawPluginApi) {
    api.registerTool(createRiskJudgeToolFactory(api), { name: "risk_judge" });

    api.registerService({
      id: "risk-judge",
      start(ctx) {
        ctx.logger.info(`[RISK_JUDGE] Service initialized (媒体白名单 ${MEDIA_WHITELIST_SIZE} 条)`);
      },
      stop(ctx) {
        ctx.logger.info("[RISK_JUDGE] Service stopped");
      },
    });
  },
});
