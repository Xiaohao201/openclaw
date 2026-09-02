const DEBUG_ROOT = "/plugins/rabbitmq-consumer/debug";
const DEBUG_RUN_PATH = `${DEBUG_ROOT}/run`;
const DEBUG_SKILLS_PATH = `${DEBUG_ROOT}/skills`;
const MAX_USER_ID_LENGTH = 128;
const MAX_SKILL_IDS = 20;

export type DebugDatabaseSkill = {
  id: number;
  name: string;
  description: string | null;
};

export type DebugTraceItem = {
  id: string;
  summary: string;
  category: string;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  repeatCount?: number;
  narrative: string[];
  toolName?: string;
  input?: string;
  output?: string;
};

export type DebugUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  models: Array<{
    provider?: string;
    model?: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
};

export type DebugTurnResult = {
  response: string;
  events: Array<Record<string, unknown>>;
  trace: DebugTraceItem[];
  usage?: DebugUsage;
};

export type DebugRunInput = {
  historyId: number;
  message: string;
  sessionId: string;
  userId: string;
  skillIds: number[];
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error("请输入用户 ID");
  }
  if (normalized.length > MAX_USER_ID_LENGTH) {
    throw new Error(`用户 ID 不能超过 ${MAX_USER_ID_LENGTH} 个字符`);
  }
  return normalized;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("本地测试服务返回了无效响应");
  }
}

function serverError(payload: unknown, fallback: string): Error {
  if (payload && typeof payload === "object") {
    const message = (payload as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) {
      return new Error(message);
    }
  }
  return new Error(fallback);
}

function normalizeSkillIds(skillIds: number[]): number[] {
  return [...new Set(skillIds.filter((id) => Number.isInteger(id) && id > 0))].slice(
    0,
    MAX_SKILL_IDS,
  );
}

export function buildDebugRunPayload(input: DebugRunInput): Record<string, unknown> {
  const skillIds = normalizeSkillIds(input.skillIds);
  return {
    id: input.historyId,
    message: input.message.trim(),
    session_id: input.sessionId,
    user_id: normalizeUserId(input.userId),
    use_memory: false,
    ...(skillIds.length > 0 ? { skill_ids: skillIds } : {}),
  };
}

export async function loadDatabaseSkills(
  userId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DebugDatabaseSkill[]> {
  const normalizedUserId = normalizeUserId(userId);
  const response = await fetchImpl(
    `${DEBUG_SKILLS_PATH}?user_id=${encodeURIComponent(normalizedUserId)}`,
    { credentials: "same-origin", headers: { accept: "application/json" } },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw serverError(payload, "数据库 Skills 暂时无法读取");
  }
  const rows =
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { skills?: unknown }).skills)
      ? (payload as { skills: unknown[] }).skills
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const value = row as Record<string, unknown>;
    if (!Number.isInteger(value.id) || Number(value.id) <= 0 || typeof value.name !== "string") {
      return [];
    }
    const name = value.name.trim();
    if (!name) {
      return [];
    }
    return [
      {
        id: Number(value.id),
        name,
        description: typeof value.description === "string" ? value.description : null,
      },
    ];
  });
}

function normalizeTrace(value: unknown): DebugTraceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.summary !== "string") {
      return [];
    }
    const status =
      item.status === "failed" ? "failed" : item.status === "running" ? "running" : "completed";
    return [
      {
        id: item.id,
        summary: item.summary,
        category: typeof item.category === "string" ? item.category : "default",
        status,
        ...(typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
          ? { durationMs: Math.max(0, Math.round(item.durationMs)) }
          : {}),
        ...(typeof item.repeatCount === "number" && item.repeatCount > 1
          ? { repeatCount: Math.floor(item.repeatCount) }
          : {}),
        narrative: Array.isArray(item.narrative)
          ? item.narrative.filter((line): line is string => typeof line === "string")
          : [],
        ...(typeof item.toolName === "string" ? { toolName: item.toolName } : {}),
        ...(typeof item.input === "string" ? { input: item.input } : {}),
        ...(typeof item.output === "string" ? { output: item.output } : {}),
      },
    ];
  });
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function normalizeUsage(value: unknown): DebugUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const models = Array.isArray(usage.models)
    ? usage.models.flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          return [];
        }
        const model = row as Record<string, unknown>;
        return [
          {
            ...(typeof model.provider === "string" ? { provider: model.provider } : {}),
            ...(typeof model.model === "string" ? { model: model.model } : {}),
            calls: nonNegativeInteger(model.calls),
            inputTokens: nonNegativeInteger(model.inputTokens),
            outputTokens: nonNegativeInteger(model.outputTokens),
            totalTokens: nonNegativeInteger(model.totalTokens),
          },
        ];
      })
    : [];
  return {
    calls: nonNegativeInteger(usage.calls),
    inputTokens: nonNegativeInteger(usage.inputTokens),
    outputTokens: nonNegativeInteger(usage.outputTokens),
    cacheReadTokens: nonNegativeInteger(usage.cacheReadTokens),
    cacheWriteTokens: nonNegativeInteger(usage.cacheWriteTokens),
    totalTokens: nonNegativeInteger(usage.totalTokens),
    models,
  };
}

export async function runDebugTurn(
  input: DebugRunInput,
  fetchImpl: FetchLike = fetch,
): Promise<DebugTurnResult> {
  const response = await fetchImpl(DEBUG_RUN_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(buildDebugRunPayload(input)),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw serverError(payload, "本地测试请求失败");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { response?: unknown }).response !== "string"
  ) {
    throw new Error("本地测试服务未返回有效回答");
  }
  const value = payload as Record<string, unknown>;
  const usage = normalizeUsage(value.usage);
  return {
    response: value.response as string,
    events: Array.isArray(value.events)
      ? value.events.filter(
          (event): event is Record<string, unknown> =>
            Boolean(event) && typeof event === "object" && !Array.isArray(event),
        )
      : [],
    trace: normalizeTrace(value.trace),
    ...(usage ? { usage } : {}),
  };
}

export function createDebugHistoryId(
  randomValues: (target: Uint32Array<ArrayBuffer>) => void,
): number {
  const values = new Uint32Array(1);
  randomValues(values);
  return (values[0] % 2_147_483_646) + 1;
}
