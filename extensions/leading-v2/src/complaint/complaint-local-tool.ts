import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { ComplaintBatchStore } from "./complaint-batch-store.js";
import { submitComplaintBatch } from "./complaint-batch-submit.js";
import { parseLocalRequest, resolveLocalConfig } from "./complaint-local-contract.js";

export function createLocalComplaintSubmitToolFactory(api: OpenClawPluginApi) {
  const config = resolveLocalConfig(api.pluginConfig ?? {}, api.rootDir);
  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "complaint_submit",
      label: "本地举报",
      description:
        "由 OpenClaw 直接调用本地 Python 浏览器执行举报，不创建后端队列任务。" +
        "仅在用户明确授权后传 confirmed=true；使用本轮研判 basisSource=AgentJudgment、subjectScope、judgment 和 links。" +
        "批量必须为每条链接提供独立 linkJudgments，不能把批次摘要用于每条链接。事由须基于对应链接的已核验证据。" +
        "可用 complaint_taxonomy 查询本地支持平台；不需要后端 classifications 或 taxonomyVersionId。" +
        "可选 categories 使用实际平台分类文字，否则浏览器按单条研判匹配页面选项。" +
        "如用户明确选择12377匿名渠道，传 report12377；会打开官网供用户核对、验证码及手动最终提交，单条理由最多500字符。" +
        "返回 accepted 仅表示本地接收，使用 complaint_task_status({batchId}) 查询平台结果。不要自动重提。",
      parameters: Type.Object(
        {
          basisSource: Type.Literal("AgentJudgment"),
          confirmed: Type.Literal(true),
          subjectScope: Type.Union([Type.Literal("Institution"), Type.Literal("Enterprise")]),
          judgment: Type.String({ minLength: 20, maxLength: 6000 }),
          links: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
            minItems: 1,
            maxItems: 1000,
          }),
          role: Type.Optional(Type.Union([Type.Literal("Personal"), Type.Literal("Enterprise")])),
          linkJudgments: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  link: Type.String(),
                  judgment: Type.String({ minLength: 20, maxLength: 6000 }),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          categories: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  link: Type.String(),
                  category: Type.String({ minLength: 1, maxLength: 200 }),
                  subCategory: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          report12377: Type.Optional(
            Type.Object(
              {
                category: Type.Union(
                  [
                    "politics",
                    "terrorism",
                    "fraud",
                    "pornography",
                    "vulgarity",
                    "gambling",
                    "rumor",
                  ].map((value) => Type.Literal(value)),
                ),
                websiteName: Type.String({ minLength: 1, maxLength: 40 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, raw: Record<string, unknown>) {
        let items;
        try {
          items = parseLocalRequest(raw);
        } catch {
          return jsonResult({
            success: false,
            submitted: false,
            error:
              "参数无效：需明确确认、AgentJudgment、主体范围及20至6000字事由；批量逐链接提供 linkJudgments，链接须受支持且不重复。分类使用 categories 文字，不传后端 classifications。",
          });
        }
        try {
          return jsonResult(
            await submitComplaintBatch({
              store: new ComplaintBatchStore(() => api.runtime.state.resolveStateDir()),
              userId,
              local: { items, config },
            }),
          );
        } catch {
          return jsonResult({
            success: false,
            submitted: false,
            error: "保存本地批次失败，尚未执行举报。请检查状态目录。",
          });
        }
      },
    };
  };
}
