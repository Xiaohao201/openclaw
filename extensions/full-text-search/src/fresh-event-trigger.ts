export type FullTextPriorityReason = "fresh-event" | "local-social-event";

export type FullTextPriorityIntent = {
  reason: FullTextPriorityReason;
  query: string;
  dateScope: "today" | "recent";
};

const NO_NETWORK_PATTERN =
  /(?:不要|不用|别|请勿|无需|不必|禁止)(?:再)?(?:联网|上网|搜索|检索|调用|使用)|只(?:根据|用).{0,16}(?:附件|材料|原文)/u;
const FRESH_PATTERN = /(?:今天|今日|刚刚|刚才|最新|突发|刚发生|刚通报)/u;
const TASK_PATTERN =
  /(?:搜索|查询|检索|搜一下|查一下|核验|核实|舆情|速报|快报|专报|报告|研判|分析|怎么回事|新闻|通报)/u;
const EVENT_PATTERN =
  /(?:发生|事故|通报|回应|投诉|冲突|处罚|食品安全|踩踏|坠落|起火|爆炸|受伤|死亡|被查|曝光|质疑|纠纷|维权|执法|救援)/u;
const LOCAL_PLACE_PATTERN =
  /(?:北京|上海|天津|重庆|深圳|广州|杭州|南京|武汉|成都|西安|长沙|郑州|青岛|苏州|东莞|佛山|本地|当地|[\p{Script=Han}]{2,12}(?:省|市|区|县|镇|街道)|门店|餐厅|商场|学校|医院|小区|地铁站|景区|工厂)/u;

function stripInternalContext(prompt: string): string {
  return prompt
    .replace(/Sender \(untrusted metadata\):\s*```[\s\S]*?```/giu, " ")
    .replace(/\[(?:userId|topicId|historyId|auto-selected-skill|builtin-skill)[^]*?\]/giu, " ")
    .replace(/\[[A-Z][a-z]{2}[^]*?GMT[^]*?\]/gu, " ")
    .replace(/(?:请使用|使用)\s*\$[\w-]+\s*完成任务[。.!]?/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractPublicQuery(prompt: string): string | null {
  const candidate = stripInternalContext(prompt)
    .replace(/^(?:请|帮我|给我)?\s*(?:搜索|查询|检索|搜一下|查一下|核验|核实)\s*/u, "")
    .replace(
      /^(?:今天|今日|刚刚|刚才|最新|突发|刚发生|刚通报)(?:发布的|发生的)?\s*[:：,，]?\s*/u,
      "",
    )
    .replace(
      /\s*[,，;；。]?\s*(?:请|帮我|给我)?\s*(?:(?:写|撰写)\s*)+(?:一份|该事件|这个事件|相关事件)?\s*(?:舆情)?(?:速报|快报|专报|报告|研判|分析)?\s*$/u,
      "",
    )
    .replace(
      /\s*[,，;；。]?\s*(?:请|帮我|给我)?\s*(?:生成|形成|制作|做|查一下|搜一下|核验|核实)(?:一份|该事件|这个事件|相关事件)?\s*(?:舆情)?(?:速报|快报|专报|报告|研判|分析)?\s*$/u,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (!candidate || Array.from(candidate).length > 500) {
    return null;
  }
  return candidate;
}

/** Identify fresh or local social-event requests that need indexed corpus search first. */
export function parseFullTextPriorityIntent(
  prompt: string,
  _now: Date = new Date(),
): FullTextPriorityIntent | null {
  const normalized = stripInternalContext(prompt);
  if (!normalized || NO_NETWORK_PATTERN.test(normalized)) {
    return null;
  }

  const hasTask = TASK_PATTERN.test(normalized);
  const hasEvent = EVENT_PATTERN.test(normalized);
  const isFreshEvent = FRESH_PATTERN.test(normalized) && hasTask && hasEvent;
  const isLocalSocialEvent = LOCAL_PLACE_PATTERN.test(normalized) && hasTask && hasEvent;
  if (!isFreshEvent && !isLocalSocialEvent) {
    return null;
  }

  const query = extractPublicQuery(normalized);
  if (!query) {
    return null;
  }
  return {
    reason: isFreshEvent ? "fresh-event" : "local-social-event",
    dateScope: isFreshEvent ? "today" : "recent",
    query,
  };
}
