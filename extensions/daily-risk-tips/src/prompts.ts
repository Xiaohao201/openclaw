/**
 * Ported from D:\部署程序\public-opinion-disposal-report\prompt.py (generate_prompt) and
 * 豆包提示词.py (summarize_daily_risk_tips, extract_prompt). The two-turn shape is preserved:
 * turn A retrieves similar finalized examples and distills a style prompt from them; turn B
 * uses that style prompt to write the new risk tip. The stateful cross-call anti-repetition
 * (used_verbs_in_cycle / used_alert_words_in_cycle) is intentionally not ported for v1 — a
 * single stateless tool call has no cycle to track, so the placeholders below always read "无".
 */

/** Turn A system prompt: study finalized examples and distill an AI-writable style prompt. */
export const STYLE_EXTRACTION_SYSTEM_PROMPT = `你是深圳市网信办的舆情分析师，负责通过已经定稿的每日风险提示案例，总结出AI能懂的撰写规则提示词。请按照以下JSON格式输出：
<OUTPUT JSON SCHEMA>
{
  "type": "object",
  "prompt": "string"
}
</OUTPUT JSON SCHEMA>`;

export interface RetrievalRequest {
  query: string;
  collection: string;
  embeddingProfile: string;
  topK: number;
}

/** Turn A user message: instructs the model to retrieve via milvus_search, then distill style rules. */
export function buildStyleExtractionUserMessage(req: RetrievalRequest): string {
  return `请先调用 milvus_search 工具检索相关的历史定稿"每日风险提示"案例：
- collection: "${req.collection}"
- embeddingProfile: "${req.embeddingProfile}"
- query: "${req.query}"
- topK: ${req.topK}
- outputFields: ["text"]

拿到检索结果后，把每条命中案例的 text 内容各自包裹在 <每日风险提示案例>...</每日风险提示案例> 标签中作为定稿案例。

<检索失败兜底>
本任务全程只允许调用 milvus_search 这一个工具，且最多调用一次。
若这次调用报错、返回 success 为 false、或命中结果为空，则立即停止一切工具调用，
直接基于你已知的政务舆情风险提示写作惯例给出撰写规则并按要求的 JSON 格式输出。
禁止重试 milvus_search，禁止改用任何其他工具，
尤其禁止去读取本地文件、workspace 目录、历史报告或既往会话来寻找替代案例——
这些内容不是领导定稿案例，用它们提炼规则会污染输出。
也不要输出任何说明检索为何失败的旁白，直接给 JSON。
</检索失败兜底>

以上是领导定稿的每日风险提示的案例，请你研究他们的标题、结构、字数、标点符号、格式、语言风格，内容逻辑，内容价值，
并总结出AI能懂的撰写规则提示词。之后AI将适用你的提示词撰写新的每日风险提示内容，
目标是AI撰写的内容要跟定稿保持100%契合度，让人无法分辨是AI写的，还是人写的，从而大幅提升采用率。`;
}

export interface GenerationRequest {
  message: string;
  requirement?: string;
}

/** Turn B user message: the full writing-rules template, ported verbatim from 豆包提示词.py:132-214. */
export function buildGenerationUserMessage(req: GenerationRequest): string {
  return `
针对用户提供的**一个**具体政策、事件或社会现象，生成**唯一一条**风险提示。
这是用户提供的背景信息：
<背景信息>
${req.message}
</背景信息>

<特殊要求>
${req.requirement ?? ""}
</特殊要求>

<输出要求>
注意⚠️:总字数限制在150字以内
一、标题规则（保持不变）
- 15 字以内
- 动宾结构
注意：
- 动词应多样化，避免重复使用"防范""谨防""警惕""焦虑""声量抬升"等相近词汇，把事件可能引发的负面聚焦于线下
- 可参考但不局限于以下动词：加强、规范、强化、提升、优化、推动、深化、完善、健全、遏制、化解、应对、引导、促进、统筹、协调、排查、整治、评估、响应等；
- 标题需贴合报告核心内容，突出行动导向；
- 当前循环中已使用的动词：无
- 每次生成时必须选择当前循环中未使用过的动词，确保一个循环（4次任务）内的标题动词都不重复
- 不出现技术术语（如：舆情、研判、舆论等）
- 标题要加粗，紧跟标题后用句号
示例输出：**提升网络安全防护能力**、**健全合规管理体系**、**推动绿色转型进程**、**化解地方债务风险**、**监测国际市场波动**、**优化营商环境建设**等


二、地名、机构名、企业名的表述规则
背景信息若为已发生的负面舆情：模糊化处理地名和机构、企业名，避免直接点名。常见表述如"辖区"、"部分区域"、"部分企业"、"辖区内一企业"、"相关场景"、"本地服务窗口/机构"、"外地"、"外省"
背景信息若为未来将要举行的活动、会议、规划等：可正常使用明确地名（如"北京""上海""深圳""全国各地"等）。
背景信息若涉及跨区域或产业链条：可使用"相关区域""行业领域"等宽泛表述增强稳妥性。

三、正文写法要求
正文依次包含以下三个方面的内容，三方面的内容连贯成一个整体，不分段、不分行：

（一）、背景事实（30-40字）
-高度概括背景信息中涉及的核心问题或关注点，如果背景信息中提到了多个已发生、正发生或即将发生的事件的碎片信息，将多个事件整合为一种现象，由点变成面，上升到政策关切点的高度。
-所有内容必须100%源自原文，不得有任何推断、延伸、解释或引入外部知识，
-禁止使用"可能""预计""一般来说""通常情况下"等推测性表述，不得添加背景知识，不得臆测事件原因、影响、历史或政策背景，不得根据标题或上下文补充未明示的内容，
-模糊化处理地名和机构、企业名，避免直接点名，请使用"二、地名、机构名、企业名表述规则"中的表述方式。

### （二）、风险推演（50-60字）

**1. 核心逻辑要求：**
* **衔接与层进：** 背景事实与风险推演需紧密衔接，遵循"直接风险 -> 次生风险 -> 社会影响"的多层推进逻辑，避免程式化表达。
* **【关键逻辑校准】：** * **政策发布类：** 严禁直接反推负面隐患。风险应聚焦于**"执行落差"**（落实不到位、配套滞后）、**"预期偏差"**（政策误读、标准不一引发焦虑）或**"联动压力"**（行业成本传导、经营压力加大）。
    * **禁止性规定：** 全文禁止使用"深圳"或"我市"。

**2. 预警词使用规范：**
* **候选预警词库：** "需警惕"/"需防范"/"谨防"/"易引发"/"产生"/"出现"/隐患/问题/投诉增多/杂音/声量抬升/可能催生/投诉易增多/涉及 XX话题或受关注/XX隐患抬升/XX 杂音增多等。
* **【去重校验】：** 每次生成必须选择当前循环中未使用过的预警词。
* **当前循环已用词：** \`无\`

**3. 输出示例（供AI逻辑对齐）：**
* *政策类示例：* "新政印发后，**需警惕**基层配套资源落实不到位**产生**执行落差，或因解读偏差引发家长焦虑**隐患**，导致基层投诉易增多。"
* *行业类示例：* "受产能紧缺影响，**谨防**成本传导引发终端产品涨价，**出现**相关行业经营压力加大的连锁反应，致使消费预期不稳。"

（三）、建议措施（20-30字）
-严格以"建议"或"建议相关部门"两种方式开头
-句式务必简短有力，多用四至八字短语，短语之间用"，"分隔，如"强化监管力度，加强科普引导，加强政策解读，强化部门协同，完善服务供给，提升应急准备，加强源头治理"等，
-每个短语必须对应具体可执行动作；

全文自始至终保持单一段落，语义连贯，无任何换行或分段标记。
2. 标题和正文必须连成一段，全文三部分内容须无缝衔接、一气呵成，严禁分段分行或使用空行。
注意：你现在是代表网信办给其他责任归口部门提处置建议，请不要直接写出这些部门的名称，以防产生网信办指挥其他部门工作的强硬感，一定要使用委婉表述，如"建议相关部门提升应急准备"等
3.正文的字数限制为150字以内
4.表述要求：
-全程不用"研判认为"等主观判断词
-不使用定性夸大词，如"严重""巨幅""极度"等
-不渲染情绪，不推测趋势，不预设后果
-以客观、中性、治理导向为核心

质量终极标准：一线工作人员能直接根据建议开展工作 • 媒体若引用不会产生歧义或过度解读 • 领导审阅无需修改可直接签发 • 普通市民能理解风险点及应对方法

</输出要求>

<执行步骤>
第1步：解析客户输入的<背景信息>，如果用户没有输入<特殊要求>，则按<输出要求>执行。
第2步：如果用户输入了<特殊要求>，则分析客户提出的关注点或建议，根据客户意图重新组织写作框架，客户提出的内容放在最高优先级，结构围绕客户的"主线"展开，各部分内容形成有机整体，内核一致。特殊要求之外的其他标准按照<输出需求>执行。
</执行步骤>
`;
}

function stripJsonFences(response: string): string {
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    const parts = cleaned.split("```");
    cleaned = parts.length >= 3 ? parts[1] : cleaned.replace(/`/g, "");
  }
  cleaned = cleaned.trim();
  if (cleaned.toLowerCase().startsWith("json")) {
    cleaned = cleaned.slice(4).trimStart();
  }
  return cleaned;
}

/** Whether `cleaned` parsed as JSON at all, and the `prompt` field if it's a (possibly array-wrapped) object. */
function parsePromptField(cleaned: string): { parsed: boolean; value: string } {
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const prompt = (parsed as { prompt?: unknown }).prompt;
      return { parsed: true, value: typeof prompt === "string" ? prompt : "" };
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as { prompt?: unknown };
      return { parsed: true, value: typeof first?.prompt === "string" ? first.prompt : "" };
    }
    return { parsed: true, value: "" };
  } catch {
    return { parsed: false, value: "" };
  }
}

/**
 * Strictly parse a `{"prompt": "..."}` (or array-wrapped) JSON answer and pull out a non-empty
 * `prompt`. Returns null for anything else — never a fallback string — so callers can
 * distinguish "this message really is the style-rules answer" from "this message is unrelated
 * prose" when scanning several candidate assistant messages from a tool-using turn.
 */
export function tryExtractJsonStyleRules(response: string): string | null {
  if (!response || !response.trim()) {
    return null;
  }
  const { parsed, value } = parsePromptField(stripJsonFences(response));
  return parsed && value.trim() ? value : null;
}

/**
 * Port of extract_prompt: pull the `prompt` field out of turn A's JSON answer, tolerating
 * fences/prose. Falls back to returning the cleaned text itself only when JSON parsing fails
 * outright (matching the Python original) — valid JSON without a usable `prompt` field yields
 * an empty string, not a fallback.
 */
export function extractStyleRules(response: string): string {
  if (!response || !response.trim()) {
    return "";
  }
  const cleaned = stripJsonFences(response);
  const { parsed, value } = parsePromptField(cleaned);
  return parsed ? value : cleaned;
}

/** Final cleanup: drop newlines and collapse double-spaces, matching 豆包提示词.py's result.replace(...) calls. */
export function stripLayout(text: string): string {
  return text.replace(/\n/g, "").replace(/ {2}/g, "");
}
