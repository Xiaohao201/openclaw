import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginLogger, PluginRuntime } from "../api.js";
import { processChatMessage } from "./chat-pipeline.js";
import type { HistoryManager } from "./history-manager.js";
import { renderLocalDebugPage } from "./local-debug-page.js";
import type { MercureEventPusher } from "./mercure-pusher.js";
import { parseMessage } from "./message-handler.js";
import { sanitizeInternalRefs } from "./sanitize-output.js";
import type { SkillLookup, SkillSummary } from "./skill-lookup.js";
import type { ActivityStep, StepCategory } from "./tool-activity.js";
import type { ChatMessage, Citation } from "./types.js";

const DEBUG_ROOT = "/plugins/rabbitmq-consumer/debug";
const DEBUG_RUN_PATH = `${DEBUG_ROOT}/run`;
const DEBUG_SKILLS_PATH = `${DEBUG_ROOT}/skills`;
const DEBUG_SESSION_COOKIE = "openclaw.rabbitmq_debug";
const DEBUG_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;

export type LocalDebugEvent = Record<string, unknown> & {
  type: "text" | "progress" | "step" | "citations" | "done" | "report_created" | "error";
};

export type LocalDebugRunResult = {
  response: string;
  events: LocalDebugEvent[];
  trace: LocalDebugTraceItem[];
};

export type LocalDebugTraceItem = {
  id: string;
  summary: string;
  category: StepCategory;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  repeatCount?: number;
  narrative: string[];
};

type LocalDebugTraceContext = {
  request?: string;
  response?: string;
};

type LocalHistoryManager = Pick<HistoryManager, "getRecord" | "updateResponse" | "updateMetadata">;
type LocalPersistentHistoryManager = LocalHistoryManager & Pick<HistoryManager, "createRecord">;

export type LocalDebugRunPipeline = (params: {
  chatMsg: ChatMessage;
  historyManager: LocalHistoryManager;
  eventPusher: MercureEventPusher;
  runtime: PluginRuntime;
  config: OpenClawConfig;
  logger: PluginLogger;
  skillLookup?: SkillLookup;
}) => Promise<string>;

type LocalDebugExecutionTask<T> = {
  payload: unknown;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const TRACE_CATEGORIES = new Set<StepCategory>([
  "query",
  "read",
  "write",
  "search",
  "memory",
  "check",
  "report",
  "think",
  "answer",
  "schedule",
  "default",
]);

function safeTraceText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = sanitizeInternalRefs(value).replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return undefined;
  }
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized;
}

function traceStatus(value: unknown): LocalDebugTraceItem["status"] {
  return value === "failed" ? "failed" : value === "running" ? "running" : "completed";
}

function traceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function traceCategory(event: LocalDebugEvent): StepCategory {
  return typeof event.category === "string" && TRACE_CATEGORIES.has(event.category as StepCategory)
    ? (event.category as StepCategory)
    : "default";
}

function buildStepNarrative(event: LocalDebugEvent): string[] {
  const category = traceCategory(event);
  const status = traceStatus(event.status);
  const publicNarrative =
    category === "think" || !Array.isArray(event.publicNarrative)
      ? []
      : event.publicNarrative
          .map((line) => safeTraceText(line, 240))
          .filter((line): line is string => Boolean(line));
  if (publicNarrative.length > 0) {
    return publicNarrative.filter((line, index, lines) => lines.indexOf(line) === index);
  }
  // Thinking detail may originate from model reasoning, so never surface it.
  const detail = category === "think" ? undefined : safeTraceText(event.detail, 120);
  if (detail) {
    return [ensureSentence(detail)];
  }
  return status === "failed" ? ["这一步没有返回可用结果，详细错误已留在服务端日志中。"] : [];
}

function ensureSentence(value: string): string {
  return /[。！？.!?]$/u.test(value) ? value : `${value}。`;
}

function isFrameworkStep(event: LocalDebugEvent): boolean {
  if (event.type !== "step") {
    return false;
  }
  const stepId = typeof event.stepId === "string" ? event.stepId : "";
  const category = typeof event.category === "string" ? event.category : "";
  return stepId === "init" || category === "think" || category === "answer";
}

function collapseRepeatedTraceItems(trace: LocalDebugTraceItem[]): LocalDebugTraceItem[] {
  const collapsed: LocalDebugTraceItem[] = [];
  for (const item of trace) {
    const previous = collapsed.at(-1);
    if (
      previous &&
      previous.summary === item.summary &&
      previous.category === item.category &&
      previous.status === item.status &&
      previous.narrative.length === 0 &&
      item.narrative.length === 0
    ) {
      previous.repeatCount = (previous.repeatCount ?? 1) + (item.repeatCount ?? 1);
      if (previous.durationMs !== undefined || item.durationMs !== undefined) {
        previous.durationMs = (previous.durationMs ?? 0) + (item.durationMs ?? 0);
      }
      continue;
    }
    collapsed.push(item);
  }
  return collapsed;
}

export function buildLocalDebugTrace(
  events: LocalDebugEvent[],
  _context?: LocalDebugTraceContext,
): LocalDebugTraceItem[] {
  const trace: LocalDebugTraceItem[] = [];
  const stepsById = new Map<string, LocalDebugTraceItem>();
  let citationIndex = 0;
  let reportIndex = 0;
  let errorIndex = 0;

  for (const event of events) {
    if (event.type === "text" || event.type === "done") {
      continue;
    }
    if (event.type === "step") {
      if (isFrameworkStep(event)) {
        continue;
      }
      const fallbackId = `step-${trace.length + 1}`;
      const id = typeof event.stepId === "string" && event.stepId ? event.stepId : fallbackId;
      const category = traceCategory(event);
      const summary = safeTraceText(event.label, 100) ?? "执行处理步骤";
      const status = traceStatus(event.status);
      const durationMs = traceNumber(event.durationMs);
      const existing = stepsById.get(id);
      if (existing) {
        existing.summary = summary;
        existing.category = category;
        existing.status = status;
        existing.narrative = buildStepNarrative(event);
        if (durationMs !== undefined) {
          existing.durationMs = durationMs;
        }
      } else {
        const item: LocalDebugTraceItem = {
          id,
          summary,
          category,
          status,
          ...(durationMs === undefined ? {} : { durationMs }),
          narrative: buildStepNarrative(event),
        };
        stepsById.set(id, item);
        trace.push(item);
      }
      continue;
    }
    if (event.type === "progress") {
      continue;
    }
    if (event.type === "citations") {
      const citations = Array.isArray(event.citations) ? event.citations : [];
      citationIndex += 1;
      const titles: string[] = [];
      citations.slice(0, 5).forEach((citation) => {
        if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
          return;
        }
        const title = safeTraceText((citation as Record<string, unknown>).title, 120);
        if (title) {
          titles.push(title);
        }
      });
      const narrative = [`我整理了 ${citations.length} 个引用来源。`];
      if (titles.length > 0) {
        narrative.push(`其中包括：${titles.join("、")}。`);
      }
      trace.push({
        id: `citations-${citationIndex}`,
        summary: "整理引用来源",
        category: "read",
        status: "completed",
        narrative,
      });
      continue;
    }
    if (event.type === "report_created") {
      reportIndex += 1;
      const taskId =
        typeof event.taskId === "number" || typeof event.taskId === "string"
          ? String(event.taskId).slice(0, 64)
          : "已创建";
      trace.push({
        id: `report-${reportIndex}`,
        summary: "报告任务已创建",
        category: "report",
        status: "completed",
        narrative: [`报告任务已创建，任务编号为 ${taskId}。`],
      });
      continue;
    }
    if (event.type === "error") {
      errorIndex += 1;
      trace.push({
        id: `error-${errorIndex}`,
        summary: "处理过程出现异常",
        category: "check",
        status: "failed",
        narrative: ["执行未完成；详细内部错误仅保留在服务端日志中。"],
      });
    }
  }
  const unresolvedStatus: LocalDebugTraceItem["status"] = errorIndex > 0 ? "failed" : "completed";
  for (const item of trace) {
    if (item.status !== "running") {
      continue;
    }
    item.status = unresolvedStatus;
    if (unresolvedStatus === "failed" && item.narrative.length === 0) {
      item.narrative = ["这一步没有返回可用结果，详细错误已留在服务端日志中。"];
    }
  }
  return collapseRepeatedTraceItems(trace);
}

/**
 * Keep model execution outside the plugin-authenticated HTTP request context.
 * The worker is created by plugin registration, then HTTP requests only enqueue
 * messages just as the real RabbitMQ consumer does.
 */
export function createLocalDebugExecutor<T>(
  run: (payload: unknown) => Promise<T>,
): (payload: unknown) => Promise<T> {
  const queue: LocalDebugExecutionTask<T>[] = [];
  let wakeWorker: (() => void) | undefined;

  const processQueue = async (): Promise<never> => {
    while (true) {
      const task = queue.shift();
      if (!task) {
        await new Promise<void>((resolve) => {
          wakeWorker = resolve;
        });
        continue;
      }
      try {
        task.resolve(await run(task.payload));
      } catch (error) {
        task.reject(error);
      }
    }
  };
  void processQueue();

  return async (payload) =>
    await new Promise<T>((resolve, reject) => {
      queue.push({ payload, resolve, reject });
      const wake = wakeWorker;
      wakeWorker = undefined;
      wake?.();
    });
}

function createEventRecorder(): { events: LocalDebugEvent[]; pusher: MercureEventPusher } {
  const events: LocalDebugEvent[] = [];
  const withHistory = (event: LocalDebugEvent, historyId?: number): LocalDebugEvent => ({
    ...event,
    ...(historyId === undefined ? {} : { historyId }),
  });
  const record = async (event: LocalDebugEvent): Promise<boolean> => {
    events.push(event);
    return true;
  };

  return {
    events,
    pusher: {
      pushText: async (_topic, content, historyId) =>
        await record(withHistory({ type: "text", content }, historyId)),
      pushProgress: async (_topic, content, historyId) =>
        await record(withHistory({ type: "progress", content }, historyId)),
      pushStep: async (_topic, step: ActivityStep, historyId) =>
        await record(withHistory({ type: "step", ...step }, historyId)),
      pushCitations: async (_topic, citations: Citation[], historyId) =>
        await record(withHistory({ type: "citations", citations }, historyId)),
      pushDone: async (_topic, historyId) => await record(withHistory({ type: "done" }, historyId)),
      pushReportCreated: async (_topic, taskId) => await record({ type: "report_created", taskId }),
      pushError: async (_topic, error, historyId) =>
        await record(withHistory({ type: "error", error }, historyId)),
    },
  };
}

function createMemoryHistory(chatMsg: ChatMessage): LocalHistoryManager {
  const record = {
    id: chatMsg.historyId,
    sessionId: chatMsg.sessionId,
    userId: chatMsg.userId,
    message: chatMsg.message,
    response: null as string | null,
    toolsUsed: null,
    metadata: null as Record<string, unknown> | null,
    createdAt: new Date(),
  };
  return {
    getRecord: async () => record,
    updateResponse: async (_historyId, response) => {
      record.response = response;
    },
    updateMetadata: async (_historyId, metadata) => {
      record.metadata = { ...record.metadata, ...metadata };
    },
  } as LocalHistoryManager;
}

const defaultRunPipeline: LocalDebugRunPipeline = async ({
  chatMsg,
  historyManager,
  eventPusher,
  runtime,
  config,
  logger,
  skillLookup,
}) =>
  await processChatMessage(
    chatMsg,
    historyManager as HistoryManager,
    { hubUrl: "http://127.0.0.1/unused-local-debug", jwtSecret: "local-debug" },
    runtime,
    logger,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    skillLookup,
    config,
    undefined,
    { eventPusher },
  );

export function createLocalDebugRunner(params: {
  runtime: PluginRuntime;
  config: OpenClawConfig;
  logger: PluginLogger;
  runPipeline?: LocalDebugRunPipeline;
  skillLookup?: SkillLookup;
  historyManager?: LocalPersistentHistoryManager;
  prepareHistory?: () => Promise<void>;
}): (payload: unknown) => Promise<LocalDebugRunResult> {
  const runPipeline = params.runPipeline ?? defaultRunPipeline;
  return async (payload) => {
    let encoded: string;
    try {
      encoded = JSON.stringify(payload);
    } catch {
      throw new Error("Invalid RabbitMQ debug message: payload is not JSON serializable");
    }
    if (encoded === undefined) {
      throw new Error("Invalid RabbitMQ debug message: payload is not JSON serializable");
    }
    const chatMsg = parseMessage(Buffer.from(encoded), params.logger);
    if (!chatMsg) {
      throw new Error("Invalid RabbitMQ debug message");
    }

    await params.prepareHistory?.();
    const historyManager = params.historyManager ?? createMemoryHistory(chatMsg);
    if (params.historyManager) {
      await params.historyManager.createRecord(chatMsg);
    }

    const { events, pusher } = createEventRecorder();
    const response = await runPipeline({
      chatMsg,
      historyManager,
      eventPusher: pusher,
      runtime: params.runtime,
      config: params.config,
      logger: params.logger,
      skillLookup: params.skillLookup,
    });
    return {
      response,
      events,
      trace: buildLocalDebugTrace(events, { request: chatMsg.message, response }),
    };
  };
}

function isLoopback(remoteAddress: string | undefined): boolean {
  const normalized = (remoteAddress ?? "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) {
      continue;
    }
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

function matchesDebugSession(req: IncomingMessage, expected: string): boolean {
  const actual = readCookie(req, DEBUG_SESSION_COOKIE);
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("payload_too_large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

export function createLocalDebugHttpHandler(params: {
  run: (payload: unknown) => Promise<unknown>;
  logger: PluginLogger;
  listSkills?: (userId: string) => Promise<SkillSummary[]>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const debugSession = randomBytes(32).toString("base64url");
  return async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    if (pathname !== DEBUG_ROOT && pathname !== DEBUG_RUN_PATH && pathname !== DEBUG_SKILLS_PATH) {
      return false;
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: "RabbitMQ local debug is loopback-only" });
      return true;
    }
    if (pathname === DEBUG_ROOT && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader(
        "set-cookie",
        `${DEBUG_SESSION_COOKIE}=${debugSession}; HttpOnly; SameSite=Strict; ` +
          `Path=${DEBUG_ROOT}; Max-Age=${DEBUG_SESSION_MAX_AGE_SECONDS}`,
      );
      res.end(renderLocalDebugPage(DEBUG_RUN_PATH, DEBUG_SKILLS_PATH));
      return true;
    }
    if (!matchesDebugSession(req, debugSession)) {
      sendJson(res, 401, { error: "RabbitMQ local debug session is missing or expired" });
      return true;
    }
    if (pathname === DEBUG_SKILLS_PATH && req.method === "GET") {
      const userId = requestUrl.searchParams.get("user_id")?.trim() ?? "";
      if (!userId) {
        sendJson(res, 400, { error: "user_id is required" });
        return true;
      }
      if (userId.length > 128) {
        sendJson(res, 400, { error: "user_id is invalid" });
        return true;
      }
      if (!params.listSkills) {
        sendJson(res, 503, { error: "MySQL skills unavailable" });
        return true;
      }
      try {
        const skills = await params.listSkills(userId);
        sendJson(res, 200, {
          skills: skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
          })),
        });
      } catch {
        params.logger.warn("[RABBITMQ_LOCAL_DEBUG] MySQL skill list failed");
        sendJson(res, 503, { error: "MySQL skills unavailable" });
      }
      return true;
    }
    if (pathname === DEBUG_RUN_PATH && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        sendJson(res, 200, await params.run(payload));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message === "payload_too_large" ? 413 : 400;
        params.logger.warn(`[RABBITMQ_LOCAL_DEBUG] ${message}`);
        sendJson(res, statusCode, { error: message });
      }
      return true;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  };
}
