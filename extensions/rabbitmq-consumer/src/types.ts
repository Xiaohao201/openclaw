/** RabbitMQ connection config */
export interface RabbitMqConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  queue: string;
  /** Queue used to notify the report-generator plugin of new report tasks. */
  reportTaskQueue: string;
  /**
   * Channel prefetch: how many unacked messages the broker hands us at once,
   * i.e. the cross-session concurrency ceiling (per-session ordering is enforced
   * in message-consumer.ts). Keep ≤ 6 unless the broker's consumer_timeout has
   * been raised (see clampPrefetch in index.ts).
   */
  prefetch: number;
}

/** History database MySQL config */
export interface HistoryDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Writer database MySQL config (falls back to HistoryDbConfig if absent) */
export interface WriterDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Mercure push config */
export interface MercureConfig {
  hubUrl: string;
  jwtSecret: string;
}

/** Chat turn execution limits */
export interface ChatTurnConfig {
  /**
   * How long one chat turn may run before the pipeline gives up on the subagent
   * (`waitForRun`). A turn that blows this ceiling returns and persists the
   * standard Suheng learning fallback. Keep the value at or below the frontend's
   * idle timeout so the terminal event arrives before the browser gives up.
   *
   * Raising it also raises the worst-case unacked time for a single session's
   * queued burst (prefetch × timeout), which must remain under the broker's
   * `consumer_timeout` (see clampPrefetch in index.ts).
   */
  turnTimeoutMs: number;
}

/** Combined plugin config */
export interface RabbitMqPluginConfig {
  rabbitmq: RabbitMqConfig;
  historyDb: HistoryDbConfig;
  mercure: MercureConfig;
  chat: ChatTurnConfig;
}

/**
 * Portable attachment reference. The frontend uploads the original file to OSS
 * and sends this lightweight reference alongside any extracted text. The
 * consumer (on a different host) downloads it into the user's agent workspace,
 * preserving originals such as stamped PDFs whose layout/images cannot be
 * represented faithfully by text extraction alone.
 * Shape must match the frontend attachment-store.
 */
export interface AttachmentRef {
  fileId: string;
  filename: string;
  ext: string;
  /**
   * `spreadsheet` — oversized Excel materialized for full-data reads.
   * `document` — original PDF/Word/etc. materialized for evidence/layout reads.
   * `image` — 证件图片（投诉建档用）：身份证/营业执照/公章/委托书等。The agent reads
   * the materialized file to auto-recognize the doc type, then stores its
   * `ossKey` into the matching 主体档案 field via `infringe_profile_save`.
   */
  kind: "spreadsheet" | "document" | "image";
  storage: "oss";
  /** OSS public direct link the consumer downloads from. */
  ref: string;
  /** SheetJS-computed total data rows (excluding headers); spreadsheet only. */
  totalDataRows?: number;
  /**
   * OSS object key (e.g. `ibtai/upload/2026/07/…jpg`) for `image` attachments.
   * This is the exact string 投诉后端 save-profile stores into idCardFront /
   * businessLicense / sealImage / powerOfAttorney and the engine later fetches.
   */
  ossKey?: string;
}

/** Parsed RabbitMQ message body */
export interface ChatMessage {
  historyId: number;
  message: string;
  sessionId: string;
  userId: string;
  modelKey?: string;
  useMemory: boolean;
  useWebsearch: boolean;
  temperature?: number;
  maxTokens?: number;
  topic?: string;
  /**
   * report_template.id picked in the frontend's "report template" panel. When
   * present, the message is an explicit report request: the template's own
   * period drives the date scope and the report-generator loads this exact
   * template instead of waterfall-resolving one. Absent for ordinary chat.
   */
  templateId?: number;
  /**
   * True when the user attached one or more files this turn (the frontend
   * splices their MarkItDown text into `message`). An attachment means the
   * user wants the agent to analyze THAT content, so it overrides the
   * internal-DB report routing (keyword + template paths): we never query the
   * 智脑 feed tables when data was uploaded. See chat-pipeline Step 2.4/2.5.
   */
  hasAttachment?: boolean;
  /**
   * Original file references persisted by the frontend. The pipeline
   * materializes these into the agent workspace so the agent can inspect full
   * data, document layout, embedded images, stamps, and other evidence that the
   * extracted text in `message` cannot preserve.
   */
  attachments?: AttachmentRef[];
  /**
   * Active custom skill ids the user enabled in the frontend's "我的Skills"
   * panel. Sent on every message while active (they persist across turns, unlike
   * a one-shot template). The pipeline resolves each id's content from the
   * `skills` table (ownership + is_enable checked) and injects it into the agent
   * context — never spliced into the visible message. Absent for ordinary chat.
   */
  skillIds?: number[];
  /**
   * One bundled OpenClaw skill selected from a first-party frontend card.
   * When present, the agent run exposes only this skill and ignores custom
   * skill ids for the turn.
   */
  builtinSkillName?: string;
}

/**
 * A single citation/footnote source attached to an assistant answer. Emitted to
 * the frontend so it can render inline `[n]` markers (hover/click → source card)
 * and an end-of-answer "参考来源（共 X 个）" panel. `id` matches the `[n]` the
 * model wrote inline; `url` is always an external http(s) link.
 */
export interface Citation {
  id: number;
  title: string;
  url: string;
  snippet: string;
}

/**
 * Token/cost accounting for one chat turn, persisted onto the turn's
 * history_messages row. Costs are already normalized to `currency` (see
 * usage-pricing.ts); token counts are raw provider numbers.
 *
 * `input` counts uncached prompt tokens only — cache reads/writes are reported
 * separately by the provider and priced differently, so summing input +
 * cacheRead + cacheWrite is what reconstructs the full prompt size.
 */
export interface TurnUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  /** ISO-4217-ish label stored in cost_currency, e.g. "CNY". */
  currency: string;
  /** Provider/model that dominated the turn by cost. */
  provider?: string;
  model?: string;
  /** Number of model calls (one per tool-loop iteration). */
  calls: number;
}

/** History record from MySQL */
export interface HistoryRecord {
  id: number;
  sessionId: string;
  userId: string;
  message: string;
  response: string | null;
  toolsUsed: string | null;
  metadata: string | null;
  createdAt: Date;
}
