/**
 * Standardized 舆情风险研判 rubric, ported from judgemilvus `doubao_judge.py`.
 *
 * The value here is the rubric itself — a fixed 3-标准 / 5-级 grading standard a
 * senior 网信办 analyst applies. We run it against the agent's configured model
 * via a custom system prompt so the grade is reproducible and rule-anchored,
 * instead of the main agent free-judging a level ad hoc.
 */

/** Canonical risk levels, low → high. The model must pick exactly one. */
export const RISK_LEVELS = ["蓝色预警", "黄色预警", "橙色预警", "红色预警", "高危预警"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskJudgeInput {
  /** The opinion content to grade: pasted text, a title, or a URL whose slug carries the headline. */
  content: string;
  /** Publishing author/account, if known — drives 标准① via the media whitelist. */
  author?: string;
  /** Headline/title, if known. */
  title?: string;
  /** Whether `author` matched the authoritative media whitelist (resolved by the caller). */
  authorIsMedia: boolean;
}

export interface RiskJudgeResult {
  riskLevel: RiskLevel;
  /** The outward-facing 研判正文 (markdown): 等级判定、风险特征、处置建议. No internal rubric terms. */
  reportMarkdown: string;
}

/**
 * The system prompt. Mirrors judgemilvus's 资深网信办分析师 persona and the exact
 * 3-标准 / 5-级 logic, but changes the OUTPUT contract: a single fenced ```json
 * block with `risk_level` + `report_markdown`, so the tool can parse it
 * deterministically. The internal标准/思维过程 must never leak into报告正文.
 */
export const RISK_JUDGE_SYSTEM_PROMPT = `你是一位在市级网信办舆情监测中心工作的资深舆情分析师，也是有10年经验的政务舆情危机专家，了解网信部门和其他政府部门之间的工作职责划分和协同工作机制。你的风格是冷静、专业、务实，善于分析危机。

核心任务：从给定的舆情内容中发现可能产生负面舆情的弱信号，判断其风险等级，并形成一份高质量、简洁但直指要害的舆情风险评估（正文一般在1000字以内）。

背景与限制：
1. 舆情环境为中国大陆，研判须严格遵守相关法律法规。
2. 核心目标：帮助属地主管部门及时知道舆情风险的存在和等级。

风险等级判断标准（内部使用，不得写入对外正文）：
  标准1：看发文作者，是否是新闻媒体。（系统会在输入中标注作者是否命中权威媒体白名单，请以此为准）
  标准2：看事件当事人群，是否是政府机关、警察、现役/退伍军人、弱势群体、国央企、教师、学生、特殊群体或社会知名人士等重点人群。
  标准3：看舆论核心内容，是否涉及公共道德、公序良俗、公平正义、公共权力、公共安全、性别对立、种族民族歧视、邪教、暴恐、群体腐败、自杀、跳楼、食品安全、瘟疫等重大、敏感、紧急的社会议题。

分级逻辑（内部使用）：
  1. 未命中任一标准 → 基础舆情，蓝色预警；
  2. 命中任意一个标准 → 一般舆情，黄色预警；
  3. 命中任意两个标准 → 较大舆情，橙色预警；
  4. 同时命中全部三个标准 → 重大舆情，红色预警；
  5. 在命中全部标准的同时，还出现示范性/指引性/操作性暗示（如号召"都去某地讨说法""到总部去堵门"等线下聚集动员）→ 高危舆情，需立即线上线下管控。若不存在演化为线下聚集行动的情况，则不必在建议中提及，避免画蛇添足。
  标准与思维过程仅你自己掌握，对外正文只写研判结论，不得出现"标准""命中""参考数据"等字样，行文严谨流畅。

输出要求：只返回一个 \`\`\`json 代码块，不要在代码块外写任何文字。JSON 结构如下：
\`\`\`json
{
  "risk_level": "蓝色预警 | 黄色预警 | 橙色预警 | 红色预警 | 高危预警 之一，必须精确为这五个词之一",
  "report_markdown": "对外展示的研判正文（markdown）。建议包含：一、事件概述；二、风险等级判定及依据；三、风险特征分析；四、处置与防范建议。语言为正式政务表述，不得泄露内部标准与判断过程。"
}
\`\`\``;

export interface RiskJudgePrecedentOptions {
  /** Milvus collection to search/write historical cases against. */
  collection: string;
  /** How many precedent cases to request from `milvus_search`. */
  topK: number;
}

/** Build the appendix that instructs the model to use milvus for cross-time consistency. */
function buildPrecedentAppendix(opts: RiskJudgePrecedentOptions): string {
  return `

历史案例参考（可选增强，工具不可用或检索为空时按上面规则独立研判，不得因此报错或改变输出格式）：
  1. 研判前，先调用 milvus_search 工具，collection 传 "${opts.collection}"，query 用本次的标题+内容摘要，topK 传 ${opts.topK}，检索是否存在相似的历史研判案例；
  2. 若检索到高相似度案例，参考其 metadata.risk_level 与 metadata.reason_summary，同类事件尽量保持等级一致，除非本次出现明显的升级/降级要素；
  3. 在内部完成最终等级判定后，调用 milvus_upsert 工具把本次案例写回同一 collection："${opts.collection}"，entries[0].text 只写"标题 + 不超过 500 字的内容摘要"（禁止写入原文全文或可定位到具体自然人/账号的敏感信息），entries[0].metadata 包含 risk_level、author_is_media、reason_summary（研判理由摘要）、title、ts（ISO 时间戳）；
  4. 检索与写回是内部动作，不得出现在对外正文里；最终仍必须只输出一个 \`\`\`json 代码块，且该代码块必须是你整个回复的最后一段输出，写回 milvus_upsert 之后不得再补充任何文字。`;
}

/** Compose the system prompt, optionally appending the milvus 历史案例 RAG instructions. */
export function buildRiskJudgeSystemPrompt(opts: { rag?: RiskJudgePrecedentOptions } = {}): string {
  if (!opts.rag) {
    return RISK_JUDGE_SYSTEM_PROMPT;
  }
  return RISK_JUDGE_SYSTEM_PROMPT + buildPrecedentAppendix(opts.rag);
}

/** Compose the user message fed to the model alongside the system prompt. */
export function buildRiskJudgeUserMessage(input: RiskJudgeInput): string {
  const lines: string[] = [];
  if (input.title?.trim()) {
    lines.push(`标题：${input.title.trim()}`);
  }
  if (input.author?.trim()) {
    const tag = input.authorIsMedia
      ? "【命中权威媒体白名单】"
      : "【未命中权威媒体白名单/非新闻媒体】";
    lines.push(`作者：${input.author.trim()} ${tag}`);
  } else {
    lines.push("作者：未知（按非新闻媒体处理标准1）");
  }
  lines.push("", "请对以下舆情内容进行专业的风险研判：", input.content.trim());
  return lines.join("\n");
}

/** Map free-form model wording to a canonical level (e.g. "红色"/"红色预警"/"重大舆情"). */
export function normalizeRiskLevel(raw: string | undefined | null): RiskLevel | null {
  if (!raw) {
    return null;
  }
  const t = raw.trim();
  // Each level has a distinctive character, so order is not significant.
  if (t.includes("高危")) {
    return "高危预警";
  }
  if (t.includes("红")) {
    return "红色预警";
  }
  if (t.includes("橙")) {
    return "橙色预警";
  }
  if (t.includes("黄")) {
    return "黄色预警";
  }
  if (t.includes("蓝")) {
    return "蓝色预警";
  }
  return null;
}

/**
 * Parse the model's fenced-JSON answer into a structured result. Tolerant: finds
 * the first `{`…`}` span (even without fences) and recovers the level from prose
 * if the JSON is malformed. Returns null only when no level can be determined.
 */
export function parseRiskResult(modelText: string): RiskJudgeResult | null {
  if (!modelText || !modelText.trim()) {
    return null;
  }
  const start = modelText.indexOf("{");
  const end = modelText.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const jsonStr = modelText.slice(start, end + 1);
    try {
      const obj = JSON.parse(jsonStr) as { risk_level?: unknown; report_markdown?: unknown };
      const level = normalizeRiskLevel(typeof obj.risk_level === "string" ? obj.risk_level : null);
      const body = typeof obj.report_markdown === "string" ? obj.report_markdown.trim() : "";
      if (level && body) {
        return { riskLevel: level, reportMarkdown: body };
      }
      if (level) {
        // JSON had a level but no body — fall back to the whole text as the body.
        return { riskLevel: level, reportMarkdown: stripFences(modelText) };
      }
    } catch {
      // fall through to prose recovery
    }
  }
  // No usable JSON: recover the level from prose, keep the text as the body.
  const level = normalizeRiskLevel(modelText);
  if (level) {
    return { riskLevel: level, reportMarkdown: stripFences(modelText) };
  }
  return null;
}

/** Remove a leading/trailing ```json fence so a fallback body reads cleanly. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}
