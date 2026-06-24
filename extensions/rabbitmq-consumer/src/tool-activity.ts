/**
 * Sanitized tool-activity narration for frontend progress pushes.
 *
 * Translates agent `tool` stream events into generic, user-facing Chinese
 * status lines ("正在查询分析数据（第 2 步）…") and, in parallel, structured
 * timeline steps (label + category + status + duration) for the frontend's
 * collapsible "工作过程" panel.
 *
 * The tool NAME drives the label and category. A strict, opt-in whitelist
 * (resolveStepDetail) may ADDITIONALLY read a few numeric / enum-only arg
 * fields (a count, a report period) to produce an optional one-phrase `detail`
 * such as "检测 3 项" or "周报". It never reads free text (SQL, file paths,
 * shell commands, search queries), only consults a fixed key list per tool,
 * and the result is guarded to CJK + digits + spaces only. Any tool outside
 * the whitelist — and any non-numeric/non-enum field — is ignored, so sensitive
 * args still cannot leak to the frontend.
 *
 * Twin copies live in the rabbitmq-consumer and report-generator extensions
 * (self-contained packages, no cross-extension imports). Keep them
 * byte-identical: mirror any change to the other copy.
 */

/** Sanitized step category — drives the frontend's icon, never raw content. */
export type StepCategory =
  | "query"
  | "read"
  | "write"
  | "search"
  | "memory"
  | "check"
  | "report"
  | "think"
  | "answer"
  | "schedule"
  | "default";

/** A structured timeline step emitted for the frontend "工作过程" panel. */
export type ActivityStep = {
  phase: "start" | "end";
  /** Stable id pairing a `start` with its `end` (from toolCallId/itemId). */
  stepId: string;
  /** Monotonic ordering index (independent of the collapsed string counter). */
  index: number;
  label: string;
  category: StepCategory;
  status: "running" | "completed" | "failed";
  /** Wall-clock duration in ms, present on `end`. */
  durationMs?: number;
  /**
   * Optional sanitized one-phrase summary (counts / fixed enum labels only,
   * e.g. "检测 3 项" or "周报"). Never free text — see resolveStepDetail.
   */
  detail?: string;
};

/** Tool name (normalized by the agent runtime) → user-facing activity label. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  // Data query / analysis
  exec: "正在查询分析数据",
  process: "正在查询分析数据",
  feed_query: "正在检索舆情数据",
  // File reading
  read: "正在查阅资料",
  // Content editing / file output
  write: "正在撰写内容",
  edit: "正在修改内容",
  apply_patch: "正在修改内容",
  file_share: "正在生成可下载文件",
  // Web search / fetch
  web_search: "正在检索网络信息",
  web_fetch: "正在读取网页内容",
  browser: "正在浏览网页",
  tavily_search: "正在检索网络信息",
  firecrawl_search: "正在检索网络信息",
  tavily_extract: "正在读取网页内容",
  firecrawl_scrape: "正在读取网页内容",
  // Long-term memory
  memory_search: "正在回忆相关上下文",
  memory_get: "正在回忆相关上下文",
  memory_recall: "正在回忆相关上下文",
  memory_operators: "正在回忆相关上下文",
  memory_store: "正在记录长期记忆",
  memory_forget: "正在更新长期记忆",
  // 侵权 / 合规检测
  legal_check_create: "正在发起侵权检测",
  legal_check_status: "正在确认检测结果",
  // 报告生成
  report: "正在生成报告",
  report_create: "正在生成报告",
  report_status: "正在确认报告进度",
  report_stop: "正在停止报告生成",
  sheet_report_create: "正在生成表格报告",
  opinion_report_export: "正在导出舆情报告",
  opinion_content_create: "正在生成回应内容",
  // 舆情监测 / 分析
  feed_list: "正在浏览舆情列表",
  feed_reanalyze: "正在重新分析舆情",
  topic_list: "正在查看监测主题",
  monthly_stats: "正在统计舆情数据",
  opinion_analyze: "正在分析舆情",
  opinion_download_status: "正在确认下载进度",
  opinion_download_list: "正在获取下载列表",
  // 维权文书 / 任务
  letter_generate: "正在生成维权文书",
  letter_fetch: "正在查询维权文书",
  job_list: "正在查看任务进度",
  job_stop: "正在停止任务",
  // 失效链接 / 互动量刷新
  link_batch_create: "正在发起失效链接检测",
  link_batch_status: "正在确认链接检测结果",
  crawl_refresh_create: "正在刷新互动数据",
  crawl_refresh_status: "正在确认刷新进度",
  crawl_refresh_list: "正在获取刷新列表",
  // 定时任务
  schedule_create: "正在创建定时任务",
  schedule_list: "正在查看定时任务",
  schedule_delete: "正在删除定时任务",
  schedule_toggle: "正在调整定时任务",
  // 知识库
  wiki_status: "正在查阅知识库",
  wiki_lint: "正在校验知识库",
  wiki_apply: "正在更新知识库",
  // X 平台检索
  x_search: "正在检索 X 平台",
};

/** Tool name → sanitized category (icon hint only; never echoes content). */
const TOOL_CATEGORIES: Readonly<Record<string, StepCategory>> = {
  exec: "query",
  process: "query",
  feed_query: "query",
  read: "read",
  write: "write",
  edit: "write",
  apply_patch: "write",
  file_share: "write",
  web_search: "search",
  web_fetch: "search",
  browser: "search",
  tavily_search: "search",
  firecrawl_search: "search",
  tavily_extract: "search",
  firecrawl_scrape: "search",
  memory_search: "memory",
  memory_get: "memory",
  memory_recall: "memory",
  memory_operators: "memory",
  memory_store: "memory",
  memory_forget: "memory",
  legal_check_create: "check",
  legal_check_status: "check",
  report: "report",
  report_create: "report",
  report_status: "report",
  report_stop: "report",
  sheet_report_create: "report",
  opinion_report_export: "report",
  opinion_content_create: "report",
  feed_list: "query",
  feed_reanalyze: "query",
  topic_list: "query",
  monthly_stats: "query",
  opinion_analyze: "query",
  opinion_download_status: "report",
  opinion_download_list: "report",
  letter_generate: "report",
  letter_fetch: "report",
  job_list: "default",
  job_stop: "default",
  link_batch_create: "check",
  link_batch_status: "check",
  crawl_refresh_create: "query",
  crawl_refresh_status: "query",
  crawl_refresh_list: "query",
  schedule_create: "schedule",
  schedule_list: "schedule",
  schedule_delete: "schedule",
  schedule_toggle: "schedule",
  wiki_status: "memory",
  wiki_lint: "memory",
  wiki_apply: "memory",
  x_search: "search",
};

const DEFAULT_LABEL = "正在执行处理步骤";
const DEFAULT_CATEGORY: StepCategory = "default";

/**
 * Map a tool name to its sanitized activity label.
 * The name is only ever used as a lookup KEY — never echo it (or any other
 * event field) into the returned text, or unsanitized content could surface.
 */
export function resolveToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName.trim().toLowerCase()] ?? DEFAULT_LABEL;
}

/** Map a tool name to its sanitized category (lookup KEY only — never echoed). */
export function resolveToolCategory(toolName: string): StepCategory {
  return TOOL_CATEGORIES[toolName.trim().toLowerCase()] ?? DEFAULT_CATEGORY;
}

/** Known report-period enum values → fixed Chinese label (never echoes input). */
const PERIOD_LABELS: Readonly<Record<string, string>> = {
  daily: "日报",
  day: "日报",
  today: "日报",
  weekly: "周报",
  week: "周报",
  monthly: "月报",
  month: "月报",
  quarterly: "季报",
  quarter: "季报",
  yearly: "年报",
  year: "年报",
};

/** Arg keys that, if an array/number, give a safe item count. */
const COUNT_KEYS = ["links", "urls", "ids", "items", "targets", "list"] as const;
/** Arg keys for a result-size limit (safe small integer). */
const LIMIT_KEYS = ["limit", "size", "count", "page_size", "pagesize", "top"] as const;
/** Arg keys that may hold a report-period enum. */
const PERIOD_KEYS = ["period", "type", "range", "cycle"] as const;

function asArgRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/** First non-negative integer among keys (array length or numeric value). */
function readCount(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) {
      return value.length;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    if (typeof value === "string" && /^\d{1,6}$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

/** Fixed enum label for the first matching key (case-insensitive lookup). */
function readEnumLabel(
  args: Record<string, unknown>,
  keys: readonly string[],
  map: Readonly<Record<string, string>>,
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      const label = map[value.trim().toLowerCase()];
      if (label) {
        return label;
      }
    }
  }
  return undefined;
}

/**
 * Per-tool detail rules. Each reads ONLY numeric/enum fields and returns a
 * phrase built from constants + integers — never the raw arg value. A tool not
 * listed here gets no detail at all.
 */
const STEP_DETAIL_RULES: Readonly<
  Record<string, (args: Record<string, unknown>) => string | undefined>
> = {
  legal_check_create: (a) => {
    const n = readCount(a, COUNT_KEYS);
    return n ? `检测 ${n} 项` : undefined;
  },
  link_batch_create: (a) => {
    const n = readCount(a, COUNT_KEYS);
    return n ? `检测 ${n} 条链接` : undefined;
  },
  crawl_refresh_create: (a) => {
    const n = readCount(a, COUNT_KEYS);
    return n ? `刷新 ${n} 条` : undefined;
  },
  feed_query: (a) => {
    const n = readCount(a, LIMIT_KEYS);
    return n ? `获取 ${n} 条` : undefined;
  },
  opinion_analyze: (a) => {
    const n = readCount(a, LIMIT_KEYS);
    return n ? `分析 ${n} 条` : undefined;
  },
  report_create: (a) => readEnumLabel(a, PERIOD_KEYS, PERIOD_LABELS),
  sheet_report_create: (a) => readEnumLabel(a, PERIOD_KEYS, PERIOD_LABELS),
  opinion_report_export: (a) => readEnumLabel(a, PERIOD_KEYS, PERIOD_LABELS),
};

/** Defense in depth: only CJK, digits and spaces may reach the frontend. */
const SAFE_DETAIL = /^[一-鿿0-9 ]+$/;

/**
 * Build an optional sanitized `detail` phrase for a tool step. Returns undefined
 * unless the tool is whitelisted AND yields a count/enum result that passes the
 * CJK-digits-only guard. Free-text args can never surface here.
 */
export function resolveStepDetail(toolName: string, args: unknown): string | undefined {
  const rule = STEP_DETAIL_RULES[toolName.trim().toLowerCase()];
  if (!rule) {
    return undefined;
  }
  const detail = rule(asArgRecord(args))?.trim();
  if (!detail) {
    return undefined;
  }
  const capped = detail.slice(0, 24);
  return SAFE_DETAIL.test(capped) ? capped : undefined;
}

interface NarratorOptions {
  /** Receives each sanitized status line to push to the frontend. */
  push: (message: string) => void;
  /**
   * Receives structured timeline steps (start/end). Optional: when absent the
   * narrator behaves exactly like the legacy string-only version.
   */
  onStep?: (step: ActivityStep) => void;
  /** Minimum gap between pushes of the SAME label (burst collapse). */
  minIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface RunningStep {
  index: number;
  label: string;
  category: StepCategory;
  startedAt: number;
  detail?: string;
}

/**
 * Stateful narrator: feed it raw agent events, it emits sanitized status
 * lines for tool starts. Bursts of the same tool kind within `minIntervalMs`
 * collapse into one line; a different tool kind always pushes immediately.
 *
 * The structured `onStep` stream is independent of the string collapse: every
 * tool call surfaces as its own start/end pair (matched by stepId) so the
 * timeline shows real per-step status and duration.
 */
export class ToolActivityNarrator {
  private readonly push: (message: string) => void;
  private readonly onStep?: (step: ActivityStep) => void;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private step = 0;
  private lastPushAt = 0;
  private lastLabel = "";
  private stepSeq = 0;
  private readonly running = new Map<string, RunningStep>();

  constructor(options: NarratorOptions) {
    this.push = options.push;
    this.onStep = options.onStep;
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  /** Feed an agent event; only `tool` start/end phases are acted on. */
  handleAgentEvent(evt: { stream: string; data?: Record<string, unknown> }): void {
    if (evt.stream !== "tool") {
      return;
    }
    const data = evt.data ?? {};
    if (data.phase === "start") {
      this.handleStart(data);
    } else if (data.phase === "end") {
      this.handleEnd(data);
    }
  }

  private handleStart(data: Record<string, unknown>): void {
    const name = typeof data.name === "string" ? data.name : "";
    const label = resolveToolLabel(name);
    const category = resolveToolCategory(name);
    // Whitelisted count/enum summary only — never free-text args (see module doc).
    const detail = resolveStepDetail(name, data.args);
    const ts = this.now();

    // Structured step: one per tool call, never collapsed (the timeline keys
    // each by stepId so a missing `end` is reconciled by the frontend on done).
    if (this.onStep) {
      this.stepSeq += 1;
      const stepId = this.startStepId(data);
      const startedAt = readNumber(data.startedAt) ?? ts;
      this.running.set(stepId, { index: this.stepSeq, label, category, startedAt, detail });
      this.onStep({
        phase: "start",
        stepId,
        index: this.stepSeq,
        label,
        category,
        status: "running",
        ...(detail ? { detail } : {}),
      });
    }

    // Legacy collapsed string push (unchanged behavior).
    if (label === this.lastLabel && ts - this.lastPushAt < this.minIntervalMs) {
      return;
    }
    // Increment only on actual pushes so visible step numbers stay contiguous
    // even when same-tool bursts are collapsed.
    this.step += 1;
    this.lastLabel = label;
    this.lastPushAt = ts;
    this.push(`${label}（第 ${this.step} 步）…`);
  }

  private handleEnd(data: Record<string, unknown>): void {
    if (!this.onStep) {
      return;
    }
    const stepId = this.endStepId(data);
    if (stepId === null) {
      return;
    }
    const tracked = this.running.get(stepId);
    if (!tracked) {
      return;
    }
    this.running.delete(stepId);
    const status: ActivityStep["status"] = data.status === "failed" ? "failed" : "completed";
    const endedAt = readNumber(data.endedAt) ?? this.now();
    const startedAt = readNumber(data.startedAt) ?? tracked.startedAt;
    const durationMs = Math.max(0, endedAt - startedAt);
    this.onStep({
      phase: "end",
      stepId,
      index: tracked.index,
      label: tracked.label,
      category: tracked.category,
      status,
      durationMs,
      ...(tracked.detail ? { detail: tracked.detail } : {}),
    });
  }

  /** Stable id for a start: real toolCallId/itemId, else a unique synthetic id. */
  private startStepId(data: Record<string, unknown>): string {
    const id = data.toolCallId ?? data.itemId;
    if (typeof id === "string" && id) {
      return id;
    }
    if (typeof id === "number") {
      return String(id);
    }
    return `auto-${this.stepSeq}`;
  }

  /** Id for an end: only real ids can pair; synthetic starts complete on done. */
  private endStepId(data: Record<string, unknown>): string | null {
    const id = data.toolCallId ?? data.itemId;
    if (typeof id === "string" && id) {
      return id;
    }
    if (typeof id === "number") {
      return String(id);
    }
    return null;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
