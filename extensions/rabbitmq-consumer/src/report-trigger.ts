import type { PluginLogger } from "../api.js";

export type ReportPeriod = "日报" | "周报" | "月报";

/**
 * How strong the evidence is that this turn asks us to generate a 日/周/月报.
 *
 * - `confident` — act on it directly, no model call.
 * - `ambiguous` — a period keyword (or a period+report-noun combination) is
 *   present, but the phrasing does not prove the user is *asking for* one.
 *   The caller hands this to the LLM arbiter (see `report-intent-llm.ts`).
 * - `none`      — not a report request.
 */
export type ReportTriggerVerdict = "confident" | "ambiguous" | "none";

export interface ReportTriggerResult {
  /** True only for `confident`; kept as the caller's "generate now" switch. */
  isReportRequest: boolean;
  verdict: ReportTriggerVerdict;
  period: ReportPeriod | null;
  dateScope: { start: string; end: string } | null;
  requirement: string;
  /**
   * Instruction-only slice of the message (head + trailing ask). This — never
   * the pasted body — is what the LLM arbiter sees, so a 8000-character
   * document does not become a classification prompt.
   */
  instruction: string;
  /** Human-readable trace of which rule decided, for the logs. */
  reason: string;
}

/**
 * Period keywords. Deliberately NOT `/g`: a global regex kept in module scope
 * carries `lastIndex` across `.test()` calls, so every other message would
 * silently skip its match. We use `.exec` on fresh, non-global patterns.
 */
const REPORT_KEYWORDS: Array<{ period: ReportPeriod; pattern: RegExp }> = [
  { period: "日报", pattern: /日报|今日舆情|当日舆情|昨日舆情/ },
  { period: "周报", pattern: /周报|本周舆情|上周舆情/ },
  { period: "月报", pattern: /月报|本月舆情|上月舆情/ },
];

/**
 * Named outlets and programs whose titles embed a period keyword. Seeing
 * "时代周报" inside pasted source material is a citation, never a request —
 * masking them first keeps the common case off the LLM path. The list is a
 * latency optimization, not a correctness boundary: anything it misses still
 * has to clear the intent-verb rule below.
 */
const OUTLET_NAMES = [
  "时代周报",
  "每周质量报告",
  "人民日报",
  "光明日报",
  "经济日报",
  "科技日报",
  "法治日报",
  "工人日报",
  "农民日报",
  "中国日报",
  "青年日报",
  "证券日报",
  "解放日报",
  "南方日报",
  "广州日报",
  "北京日报",
  "天津日报",
  "重庆日报",
  "新华日报",
  "湖北日报",
  "河南日报",
  "河北日报",
  "大众日报",
  "四川日报",
  "浙江日报",
  "江西日报",
  "安徽日报",
  "福建日报",
  "湖南日报",
  "海南日报",
  "辽宁日报",
  "吉林日报",
  "黑龙江日报",
  "山西日报",
  "陕西日报",
  "甘肃日报",
  "青海日报",
  "宁夏日报",
  "新疆日报",
  "西藏日报",
  "云南日报",
  "贵州日报",
  "广西日报",
  "内蒙古日报",
];

/** Verbs that turn a period keyword into an actual ask. */
const ACTION_VERB =
  /生成|出具|出个|出份|出一|撰写|编写|写一|写个|写份|写篇|来一|来个|来份|做一|做个|做份|制作|编制|整理|汇总|总结|导出|需要|要一|要个|要份|给我|帮我|发我|发一|拉一|跑一|提供|产出|形成|安排|准备|看看|查下|查一下/;

/** Citation context: the keyword sits in a list of sources, not in an ask. */
const CITATION_AFTER = /^[、，,。；;）)\]】]?\s*(等|社|网|记者|报道|刊发|头版|客户端|新媒体)?/;

/** Markers that make a trailing line an instruction rather than body text. */
const TRAILING_ASK = /请|帮我|给我|麻烦|需要|以上|上面|据此|按此|参照/;

/**
 * Meta-question markers. "月报的口径是不是变了？" mentions a period keyword in a
 * short message but asks *about* reports rather than *for* one, so the
 * short-message shortcut must not fire on it.
 */
const META_QUESTION = /[?？]|吗|呢|怎么|为什么|是不是|能不能|可不可以|如何|什么时候|区别/;

/** Period hints for report asks that never say 日报/周报/月报 outright. */
const PERIOD_HINTS: Array<{ period: ReportPeriod; pattern: RegExp }> = [
  { period: "日报", pattern: /今天|今日|昨天|昨日|当日|近24小时/ },
  { period: "周报", pattern: /本周|这周|上周|近一周|近7天|最近一周/ },
  { period: "月报", pattern: /本月|这个月|上月|上个月|近一个月|近30天|最近一个月/ },
];

const REPORT_NOUN = /报告|简报|快报|专报|通报|研判|汇总|舆情分析|舆情总结/;

/** A message at or under this length is treated as all-instruction. */
const SHORT_MESSAGE_CHARS = 400;
/** Head slice taken from a long message. */
const MAX_HEAD_CHARS = 240;
/** A trailing line longer than this is body text, not a closing ask. */
const MAX_TAIL_CHARS = 120;
/** An instruction this short with a keyword in it is unambiguous ("出周报"). */
const STANDALONE_INSTRUCTION_CHARS = 40;
/** How far around a keyword we look for an intent verb. */
const VERB_WINDOW_BEFORE = 16;
const VERB_WINDOW_AFTER = 12;

/**
 * Reduce a message to the part that carries intent.
 *
 * Long turns in this product are "instruction + pasted material": the ask sits
 * on the first line (sometimes repeated as a closing line), and everything
 * between is source text the user wants processed. Scanning the whole blob is
 * what let a media name inside the material trigger a report.
 */
export function extractInstruction(message: string): string {
  const cleaned = message.replace(/```[\s\S]*?```/g, " ").trim();
  if (cleaned.length <= SHORT_MESSAGE_CHARS) {
    return cleaned;
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const head = (lines[0] ?? "").slice(0, MAX_HEAD_CHARS);

  const last = lines[lines.length - 1] ?? "";
  const isClosingAsk =
    lines.length > 1 &&
    last !== lines[0] &&
    last.length <= MAX_TAIL_CHARS &&
    TRAILING_ASK.test(last);

  return isClosingAsk ? `${head}\n${last}` : head;
}

/** Blank out known outlet names so their embedded keywords can't match. */
function maskOutlets(text: string): string {
  let masked = text;
  for (const name of OUTLET_NAMES) {
    masked = masked.split(name).join("＊".repeat(name.length));
  }
  return masked;
}

interface KeywordHit {
  period: ReportPeriod;
  index: number;
  length: number;
}

function findKeywordHits(text: string): KeywordHit[] {
  const hits: KeywordHit[] = [];
  for (const { period, pattern } of REPORT_KEYWORDS) {
    const match = pattern.exec(text);
    if (match) {
      hits.push({ period, index: match.index, length: match[0].length });
    }
  }
  return hits.toSorted((a, b) => a.index - b.index);
}

/** Is there an intent verb close enough to this keyword to make it an ask? */
function hasNearbyVerb(text: string, hit: KeywordHit): boolean {
  const before = text.slice(Math.max(0, hit.index - VERB_WINDOW_BEFORE), hit.index);
  const after = text.slice(hit.index + hit.length, hit.index + hit.length + VERB_WINDOW_AFTER);
  return ACTION_VERB.test(before) || ACTION_VERB.test(after);
}

/** Does the keyword read as an item in a source list ("…周报、…网等媒体")? */
function looksLikeCitation(text: string, hit: KeywordHit): boolean {
  const after = text.slice(hit.index + hit.length, hit.index + hit.length + 6);
  const prevChar = text[hit.index - 1] ?? "";
  const citationTail = CITATION_AFTER.exec(after);
  const taggedAfter = Boolean(citationTail?.[1]);
  return taggedAfter || prevChar === "、" || after.startsWith("、");
}

/** Period implied by relative-time wording, earliest mention wins. */
function inferPeriodFromHint(text: string): ReportPeriod | null {
  let best: { period: ReportPeriod; index: number } | null = null;
  for (const { period, pattern } of PERIOD_HINTS) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index)) {
      best = { period, index: match.index };
    }
  }
  return best?.period ?? null;
}

function build(
  verdict: ReportTriggerVerdict,
  period: ReportPeriod | null,
  requirement: string,
  instruction: string,
  reason: string,
): ReportTriggerResult {
  return {
    isReportRequest: verdict === "confident",
    verdict,
    period,
    dateScope: verdict !== "none" && period ? computeDateScope(period) : null,
    requirement,
    instruction,
    reason,
  };
}

/**
 * Decide whether a message asks us to generate a 日/周/月报.
 *
 * Layered, cheapest first:
 *   1. Shrink the message to its instruction (head + closing ask).
 *   2. Mask outlet names that embed a period keyword.
 *   3. A keyword in a short instruction, or next to an intent verb -> confident.
 *   4. A keyword in citation position with no verb -> none.
 *   5. Anything else with a keyword, or a period hint plus a report noun plus a
 *      verb -> ambiguous, for the caller's LLM arbiter to settle.
 */
export function detectReportRequest(message: string, logger: PluginLogger): ReportTriggerResult {
  const requirement = message.trim();
  const instruction = extractInstruction(requirement);
  const scanned = maskOutlets(instruction);
  const hits = findKeywordHits(scanned);

  if (hits.length === 0) {
    // No keyword: catch phrasings like "把上周的舆情整理成一份简报".
    const hinted = inferPeriodFromHint(scanned);
    if (hinted && REPORT_NOUN.test(scanned) && ACTION_VERB.test(scanned)) {
      logger.info(`[REPORT_TRIGGER] Ambiguous (period hint + report noun) -> ${hinted}`);
      return build("ambiguous", hinted, requirement, instruction, "period-hint+report-noun");
    }
    return build("none", null, requirement, instruction, "no-keyword");
  }

  const standalone =
    instruction.length <= STANDALONE_INSTRUCTION_CHARS && !META_QUESTION.test(instruction);
  const confident = hits.find((hit) => standalone || hasNearbyVerb(scanned, hit));
  if (confident) {
    logger.info(
      `[REPORT_TRIGGER] Detected ${confident.period} report request: ${JSON.stringify(instruction.slice(0, 120))}`,
    );
    return build("confident", confident.period, requirement, instruction, "keyword+intent");
  }

  const allCited = hits.every((hit) => looksLikeCitation(scanned, hit));
  if (allCited) {
    logger.info(
      `[REPORT_TRIGGER] Keyword(s) ${hits.map((h) => h.period).join("/")} look like citations, ` +
        `not a request; handling as normal chat`,
    );
    return build("none", null, requirement, instruction, "citation-context");
  }

  logger.info(
    `[REPORT_TRIGGER] Keyword ${hits[0].period} present without a clear ask; deferring to LLM`,
  );
  return build("ambiguous", hits[0].period, requirement, instruction, "keyword-without-verb");
}

/**
 * Compute dateScope based on period and current time.
 * All times are in UTC+8 (Asia/Shanghai).
 */
export function computeDateScope(period: ReportPeriod): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const dayOfWeek = now.getDay(); // 0 = Sunday

  switch (period) {
    case "日报": {
      // yesterday 00:00 ~ today 00:00
      const yesterday = new Date(year, month, date - 1);
      const today = new Date(year, month, date);
      return {
        start: formatDateTime(yesterday),
        end: formatDateTime(today),
      };
    }

    case "周报": {
      // last Monday 00:00 ~ this Sunday 00:00
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const lastMonday = new Date(year, month, date - daysFromMonday - 7);
      const thisSunday = new Date(year, month, date - daysFromMonday);
      return {
        start: formatDateTime(lastMonday),
        end: formatDateTime(thisSunday),
      };
    }

    case "月报": {
      // last month 1st 00:00 ~ this month 1st 00:00
      const lastMonth = month === 0 ? 11 : month - 1;
      const lastMonthYear = month === 0 ? year - 1 : year;
      const thisMonthYear = year;

      const lastMonthStart = new Date(lastMonthYear, lastMonth, 1);
      const thisMonthStart = new Date(thisMonthYear, month, 1);

      return {
        start: formatDateTime(lastMonthStart),
        end: formatDateTime(thisMonthStart),
      };
    }

    default: {
      // Unreachable: ReportPeriod is a closed union. Satisfies consistent-return.
      throw new Error(`Unknown report period: ${String(period)}`);
    }
  }
}

/**
 * Format date as YYYY-MM-DD HH:mm:ss in UTC+8 (Asia/Shanghai).
 */
function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}
