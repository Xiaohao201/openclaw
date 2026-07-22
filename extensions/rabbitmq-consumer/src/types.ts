/** RabbitMQ connection config */
export interface RabbitMqConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  queue: string;
  /** Queue used to notify the report-generator plugin of new report tasks. */
  reportTaskQueue: string;
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

/** Combined plugin config */
export interface RabbitMqPluginConfig {
  rabbitmq: RabbitMqConfig;
  historyDb: HistoryDbConfig;
  mercure: MercureConfig;
}

/**
 * Large-sheet attachment reference. The frontend uploads an oversized Excel
 * (rows beyond the inline threshold) to OSS and sends only this lightweight
 * reference — never the full table — so the message body stays small. The
 * consumer (on a different host) downloads the file via HTTP into the user's
 * agent workspace, letting the agent read full row-level data on demand (code
 * execution / Excel skill) instead of estimating from a 15-row sample.
 * Shape must match the frontend attachment-store.
 */
export interface AttachmentRef {
  fileId: string;
  filename: string;
  ext: string;
  kind: "spreadsheet";
  storage: "oss";
  /** OSS public direct link the consumer downloads from. */
  ref: string;
  /** SheetJS-computed total data rows (excluding headers); used in the prompt. */
  totalDataRows: number;
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
   * Large-sheet file references (originals persisted to the shared inbox). The
   * pipeline materializes these into the agent workspace so the agent can read
   * full data on demand. Small files/non-spreadsheets carry no ref (their text
   * is already inlined in `message`).
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
