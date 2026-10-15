import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { parseLocalRequest, resolveLocalConfig } from "./complaint-local-contract.js";
import {
  KEEP_COMPLAINT_CHANNEL,
  submitRecordedLocalComplaint,
} from "./complaint-local-submission.js";

export function createLocalComplaintSubmitToolFactory(api: OpenClawPluginApi) {
  const config = resolveLocalConfig(api.pluginConfig ?? {}, api.rootDir, api.config);
  return (ctx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "complaint_submit",
      label: "本地举报",
      description:
        "先写入 legal_complaint_task 并保存本地批次，再由本地 Python 浏览器执行举报；不投递后端队列，入库失败不执行。" +
        "直接平台举报必须先在本对话用 browser 打开或查看目标标签页；执行器接续该标签页及其登录态，不另开浏览器。交接仅限当前用户已绑定的 host profile，禁止借用其他用户账号。" +
        "仅对用户已核定的目标及举报事由，在明确授权后传 confirmed=true；不得自行挑选对象并作出违规认定后自动举报。使用本轮研判 basisSource=AgentJudgment、subjectScope、judgment 和 links。" +
        "批量必须为每条链接提供独立 linkJudgments，不能把批次摘要用于每条链接。事由须基于对应链接的已核验证据。" +
        "linkJudgments 必须是对象数组，不能传 JSON 字符串。用户确认仅授权操作，不构成事实证据；" +
        "不得把未查到佐证写成已证伪，不得因用户要求全部举报而将此前正常评价改写为违法事实；无新增证据须保留原研判。视频、正文或通报读取失败须保留为证据缺口，不能补写确定的违规结论。" +
        "可用 complaint_taxonomy 查询本地支持平台；不需要后端 classifications 或 taxonomyVersionId。" +
        "可选 categories 使用实际平台分类文字，否则浏览器按单条研判匹配页面选项。" +
        "如用户明确选择12377匿名渠道，传 report12377；会打开官网供用户核对、验证码及手动最终提交，单条理由最多500字符。" +
        "登录或会话未准备好时用 complaint_browser 引导当前用户登录并保存，不能复用其他用户账号。" +
        "返回 accepted 仅表示本地接收，使用 complaint_task_status({batchId}) 查询平台结果。不要自动重提。" +
        KEEP_COMPLAINT_CHANNEL,
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
        return jsonResult(await submitRecordedLocalComplaint({ api, ctx, userId, items, config }));
      },
    };
  };
}
