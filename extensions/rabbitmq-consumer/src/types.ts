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
