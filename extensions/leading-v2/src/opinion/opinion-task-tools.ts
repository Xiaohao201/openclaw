import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { RecentTaskStore } from "../client/recent-tasks.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";

/** Optional display metadata; status selection always uses an explicit slug from the conversation. */
export interface RecentDownload {
  slug: string;
  category: string;
  title: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  Pending: "处理中",
  Done: "已完成",
  Fail: "失败",
  Stop: "已停止",
};

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

// 速报 (Flash) is intentionally not a backend tool — the agent writes flash briefings directly in chat.
const ANALYZE_CATEGORIES = ["RiskEvaluation", "Disposal", "DailyRiskTips"] as const;
const EXPORT_CATEGORIES = ["Report", "Feed", "AllFeed"] as const;

const AnalyzeSchema = Type.Object(
  {
    data: Type.String({
      description:
        "The 舆情 content to analyze: news text, a paragraph, or text containing http(s) links " +
        "(the backend auto-crawls up to 3 links). ",
    }),
    category: Type.Optional(
      stringEnum(
        ANALYZE_CATEGORIES,
        "RiskEvaluation=风险研判(default), Disposal=舆情处置快报, DailyRiskTips=每日风险提示.",
      ),
    ),
    title: Type.Optional(
      Type.String({ description: "Optional title; auto-derived from data if omitted." }),
    ),
    requirement: Type.Optional(
      Type.String({ description: "Custom analysis instruction, e.g. '主要做风险研判'." }),
    ),
    cluster: Type.Optional(
      Type.Boolean({ description: "Enable cluster analysis (聚类). Default false." }),
    ),
  },
  { additionalProperties: false },
);

const ExportSchema = Type.Object(
  {
    reportId: Type.Number({
      description: "智脑项目 ID (must be a DailyMonitoring project). Required.",
    }),
    category: Type.Optional(
      stringEnum(
        EXPORT_CATEGORIES,
        "Report=智脑分析报告(日/周/月)(default), Feed=智脑数据下载, AllFeed=原始数据下载.",
      ),
    ),
    dateType: Type.Optional(
      stringEnum(
        ["date", "week", "month", "datetimerange"] as const,
        "For category=Report: date=日报, week=周报, month=月报, datetimerange=自定义.",
      ),
    ),
    dateScope: Type.Optional(
      Type.String({
        description:
          "For category=Report: the period. date='YYYY-MM-DD', month='YYYY-MM', week='YYYY-N周'. " +
          "For datetimerange pass 'start,end'.",
      }),
    ),
    topicId: Type.Optional(Type.Number({ description: "监测方案 ID (optional)." })),
  },
  { additionalProperties: false },
);

const SheetSchema = Type.Object(
  {
    fileLink: Type.String({
      description:
        "Public URL to an .xlsx/.csv of 舆情 data. The filename must carry a 14-char prefix " +
        "(e.g. a YYYYMMDDHHmmss timestamp) — the title is taken from char 15 onward.",
    }),
    requirement: Type.Optional(
      Type.String({ description: "Analysis requirement, e.g. '写一篇分析报告'." }),
    ),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    slug: Type.String({
      minLength: 1,
      description:
        "本次请求关联的任务标识，来自创建结果或 opinion_download_list；不要向用户展示或改用最近任务。",
    }),
  },
  { additionalProperties: false },
);

const ListSchema = Type.Object(
  {
    category: Type.Optional(
      Type.String({
        description: "Filter by category (comma-separated for several) or 'All'. Default All.",
      }),
    ),
    page: Type.Optional(Type.Number({ description: "Page number. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size 10-100. Default 20." })),
  },
  { additionalProperties: false },
);

const ContentSchema = Type.Object(
  {
    title: Type.Optional(
      Type.String({
        description:
          "报告/任务标题（可只给其中一段，用于在下载列表中定位要读取的那一条）。" +
          "省略时读取最近一条已完成任务的正文。",
      }),
    ),
    category: Type.Optional(
      Type.String({
        description:
          "Optional category filter (same values as opinion_download_list). Default All.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Trim report body to a short preview for list rows (full text via opinion_download_content). */
function excerptOf(raw: unknown, max = 160): string | null {
  const text = asString(raw);
  if (!text) {
    return null;
  }
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return null;
  }
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Pick the download row to read full content from. Done rows win over in-progress
 * ones; an explicit title narrows by exact match first, then substring. fetch-downloads
 * returns rows most-recent-first, so index 0 of any pool is the latest.
 */
function pickContentRow(
  items: Record<string, unknown>[],
  titleQuery: string | undefined,
): { row: Record<string, unknown> | null; matches: number } {
  const done = items.filter((it) => asString(it.status) === "Done");
  const pool = done.length > 0 ? done : items;
  if (!titleQuery) {
    return { row: pool[0] ?? null, matches: pool.length > 0 ? pool.length : 0 };
  }
  const q = titleQuery.trim().toLowerCase();
  const exact = pool.filter((it) => (asString(it.title) ?? "").toLowerCase() === q);
  if (exact.length > 0) {
    return { row: exact[0], matches: exact.length };
  }
  const partial = pool.filter((it) => (asString(it.title) ?? "").toLowerCase().includes(q));
  return { row: partial[0] ?? null, matches: partial.length };
}

/** Find a submitted task row in fetch-downloads, matching by slug. */
async function findDownloadBySlug(
  config: BackendConfig,
  apiKey: string,
  category: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const res = await getJson(
    config,
    "/pub-opinion/fetch-downloads",
    { category: category || "All", page: 1, size: 50 },
    apiKey,
  );
  const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
  return items.find((item) => asString(item.slug) === slug) ?? null;
}

export function createOpinionAnalyzeToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_analyze",
      label: "Analyze Opinion / 舆情简报",
      description:
        "Submit text or links for an asynchronous 舆情报告 (风险研判/处置快报/风险提示). This is not a 内容检测 task and cannot supply jobId to letter_generate. For a single-link complaint document, use current evidence and the selected skill to analyze and create the document directly. " +
        "Use this for requested background reports or batch analysis. Query opinion_download_status with the returned slug. " +
        "The analysis text comes back in the status result's content/title. Tracked server-side; never mention any id to the user.",
      parameters: AnalyzeSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_analyze");
        if ("error" in keyed) {
          return keyed.error;
        }
        const data = asString(rawParams.data);
        if (!data) {
          return jsonResult({
            success: false,
            error: "data is required (the text or links to analyze).",
          });
        }
        const category = ANALYZE_CATEGORIES.includes(
          rawParams.category as (typeof ANALYZE_CATEGORIES)[number],
        )
          ? (rawParams.category as string)
          : "RiskEvaluation";
        const fields: Record<string, FieldValue> = {
          category,
          data,
          title: asString(rawParams.title),
          requirement: asString(rawParams.requirement),
          cluster: rawParams.cluster ? 1 : 0,
          siteId: config.siteId,
          ip: "127.0.0.1",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/request-download", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "opinion_analyze", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.slug);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        const title = asString(rawParams.title) ?? data.replace(/https?:\/\/\S+/g, "").slice(0, 40);
        store.remember(userId, { slug, category, title });
        return jsonResult({
          success: true,
          submitted: true,
          slug,
          taskType: "OpinionReport",
          category,
          title,
          message: asString(res.message) ?? "任务已提交",
          agentInstruction:
            "后台报告已提交，尚无研判结果。用此 slug 查询同一任务；它不是内容检测任务，不能直接驱动 letter_generate。避免连续轮询，可继续不依赖报告的工作；未安排真实调度时不要承诺自动通知。",
        });
      },
    };
  };
}

export function createOpinionExportToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_report_export",
      label: "Export 智脑 Report / Data",
      description:
        "Export a 智脑项目 report (日/周/月报) or its 舆情数据 to a file. Requires the project's reportId. " +
        "Runs asynchronously — pass the returned slug to opinion_download_status, then read fileLink when Done. " +
        "Tracked server-side; never mention any id to the user.",
      parameters: ExportSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_report_export");
        if ("error" in keyed) {
          return keyed.error;
        }
        const reportId = Number(rawParams.reportId);
        if (!Number.isInteger(reportId) || reportId <= 0) {
          return jsonResult({ success: false, error: "reportId is required (the 智脑项目 id)." });
        }
        const category = EXPORT_CATEGORIES.includes(
          rawParams.category as (typeof EXPORT_CATEGORIES)[number],
        )
          ? (rawParams.category as string)
          : "Report";
        const dateType = asString(rawParams.dateType);
        const dateScopeRaw = asString(rawParams.dateScope);
        // datetimerange takes an array; other dateTypes take a scalar scope.
        const dateScope: FieldValue =
          dateType === "datetimerange" && dateScopeRaw
            ? dateScopeRaw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : dateScopeRaw;

        const fields: Record<string, FieldValue> = {
          category,
          reportId,
          topicId: Number.isInteger(Number(rawParams.topicId))
            ? Number(rawParams.topicId)
            : undefined,
          dateType: category === "Report" ? dateType : undefined,
          dateScope: category === "Report" ? dateScope : undefined,
          siteId: config.siteId,
          ip: "127.0.0.1",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/request-download", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "opinion_report_export", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.slug);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        store.remember(userId, { slug, category, title: null });
        return jsonResult({
          success: true,
          submitted: true,
          slug,
          category,
          message: asString(res.message) ?? "任务已提交",
          agentInstruction:
            "报告导出已提交。用此 slug 查询同一任务，避免连续轮询；可继续其他独立工作，不要把提交成功说成文件已生成。",
        });
      },
    };
  };
}

export function createSheetReportToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "sheet_report_create",
      label: "Create 精品报告 from Sheet",
      description:
        "Submit an .xlsx/.csv of 舆情 data (by public URL) for 精品报告 generation. " +
        "Runs asynchronously — pass the returned slug to opinion_download_status, then read fileLink when Done. " +
        "Tracked server-side; never mention any id to the user.",
      parameters: SheetSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "sheet_report_create");
        if ("error" in keyed) {
          return keyed.error;
        }
        const fileLink = asString(rawParams.fileLink);
        if (!fileLink) {
          return jsonResult({
            success: false,
            error: "fileLink is required (a public .xlsx/.csv URL).",
          });
        }
        const fields: Record<string, FieldValue> = {
          fileLink,
          requirement: asString(rawParams.requirement) ?? "",
          siteId: config.siteId,
          ip: "127.0.0.1",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(
            config,
            "/pub-opinion/submit-sheet-report-job",
            fields,
            keyed.apiKey,
          );
        } catch (error) {
          return failure(api, "sheet_report_create", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.slug);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        store.remember(userId, { slug, category: "SheetReport", title: null });
        return jsonResult({
          success: true,
          submitted: true,
          slug,
          message: asString(res.message) ?? "任务已提交",
          agentInstruction:
            "精品报告已提交。用此 slug 查询同一任务，避免连续轮询；可继续其他独立工作，不要把提交成功说成报告已完成。",
        });
      },
    };
  };
}

export function createOpinionDownloadStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_download_status",
      label: "舆情 Task Status",
      description:
        "Get status/result of the explicitly selected 舆情 task using its returned slug. Never fall back to another task. Avoid repeated polling without new information; pending tasks do not prevent independent work, and completed results can be used to continue the user's workflow.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_download_status");
        if ("error" in keyed) {
          return keyed.error;
        }
        const slug = asString(rawParams.slug)?.trim();
        const latest = store.latest(userId);
        const recent = latest?.slug === slug ? latest : undefined;
        const category = "All";
        if (!slug) {
          return jsonResult({
            success: false,
            code: "TASK_REQUIRED",
            error: "请提供本次任务的 slug，来自创建结果或任务列表；不会自动查询账户最近任务。",
          });
        }

        let row: Record<string, unknown> | null;
        try {
          row = await findDownloadBySlug(config, keyed.apiKey, category, slug);
        } catch (error) {
          return failure(api, "opinion_download_status", userId, error);
        }
        if (!row) {
          return jsonResult({
            success: true,
            found: false,
            slug,
            agentInstruction:
              "未在本次查询范围内找到该任务，不能据此断言仍在排队；核对任务标识或列表，不要改用另一任务或连续轮询。可继续其他独立工作。",
          });
        }
        const status = asString(row.status) ?? "";
        const fileLink = asString(row.fileLink);
        const done = status === "Done";
        const failed = status === "Fail";
        const stopped = status === "Stop";
        const terminal = done || failed || stopped;
        return jsonResult({
          success: true,
          found: true,
          slug,
          status,
          statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
          ...(terminal ? { done, failed, stopped } : {}),
          title: asString(row.title) ?? recent?.title ?? null,
          fileLink: fileLink ?? null,
          content: asString(row.content) ?? null,
          memo: asString(row.memo) ?? null,
          agentInstruction: terminal
            ? "该任务已结束。成功时可依据真实结果继续用户已要求的后续工作；失败或停止时说明具体状态，不要当作研判已完成。"
            : "该任务仍在处理中，尚无完成结果。避免连续轮询同一任务；可以继续获取证据、整理材料等独立工作，不必结束整个流程。",
        });
      },
    };
  };
}

export function createOpinionDownloadListToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_download_list",
      label: "List 舆情 Tasks",
      description:
        "List this account's 舆情 download/report tasks (most recent first), optionally filtered by category. " +
        "Use it when the user asks what reports/exports exist.",
      parameters: ListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_download_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const page = Math.max(1, Number(rawParams.page ?? 1) || 1);
        const size = Math.min(100, Math.max(10, Number(rawParams.size ?? 20) || 20));
        const category = asString(rawParams.category) ?? "All";

        let res: Record<string, unknown>;
        try {
          res = await getJson(
            config,
            "/pub-opinion/fetch-downloads",
            { category, page, size },
            keyed.apiKey,
          );
        } catch (error) {
          return failure(api, "opinion_download_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
        const list = items.map((item) => {
          const status = asString(item.status) ?? "";
          return {
            slug: asString(item.slug) ?? null,
            category: asString(item.category) ?? null,
            status,
            statusLabel: STATUS_LABELS[status] ?? status,
            title: asString(item.title) ?? null,
            fileLink: asString(item.fileLink) ?? null,
            excerpt: excerptOf(item.content),
            date: asString(item.date) ?? null,
          };
        });
        return jsonResult({
          success: true,
          total: Number(res.total ?? list.length),
          list,
          agentInstruction:
            "excerpt 仅为正文摘要。需要某条报告的完整正文时，调用 opinion_download_content 并传入对应 title。",
        });
      },
    };
  };
}

export function createOpinionDownloadContentToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_download_content",
      label: "Read 舆情 Report Content",
      description:
        "Read the full body of a finished 舆情/智脑 report or analysis task (the text stored on its download row). " +
        "Pass the report's title (or a fragment of it, e.g. from opinion_download_list); omit it to read the most " +
        "recent finished task. Returns the full content plus fileLink/memo when present. " +
        "Use this when the user asks to see/summarize/quote the actual report — opinion_download_list only carries an excerpt.",
      parameters: ContentSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_download_content");
        if ("error" in keyed) {
          return keyed.error;
        }
        const category = asString(rawParams.category) ?? "All";
        const titleQuery = asString(rawParams.title);

        let res: Record<string, unknown>;
        try {
          res = await getJson(
            config,
            "/pub-opinion/fetch-downloads",
            { category, page: 1, size: 50 },
            keyed.apiKey,
          );
        } catch (error) {
          return failure(api, "opinion_download_content", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
        if (items.length === 0) {
          return jsonResult({
            success: true,
            found: false,
            agentInstruction: "该账号暂无任何下载/报告任务。请如实告知用户。",
          });
        }

        const { row, matches } = pickContentRow(items, titleQuery);
        if (!row) {
          return jsonResult({
            success: true,
            found: false,
            agentInstruction:
              "未找到标题匹配的报告。请先用 opinion_download_list 确认确切标题，再用 opinion_download_content 重试。",
          });
        }

        const status = asString(row.status) ?? "";
        const content = asString(row.content);
        const fileLink = asString(row.fileLink);
        if (!content && !fileLink) {
          return jsonResult({
            success: true,
            found: true,
            hasContent: false,
            status,
            statusLabel: STATUS_LABELS[status] ?? status,
            title: asString(row.title) ?? null,
            agentInstruction:
              status === "Done"
                ? "该报告已完成但正文为空（可能仅以文件或邮件形式交付）。请如实告知用户，可让其到网页端查看。"
                : "该报告尚未生成完成，暂无正文。请告知用户稍后再试。",
          });
        }

        return jsonResult({
          success: true,
          found: true,
          hasContent: Boolean(content),
          status,
          statusLabel: STATUS_LABELS[status] ?? status,
          title: asString(row.title) ?? null,
          category: asString(row.category) ?? null,
          content: content ?? null,
          fileLink: fileLink ?? null,
          memo: asString(row.memo) ?? null,
          date: asString(row.date) ?? null,
          ...(titleQuery && matches > 1 ? { ambiguous: true, matched: matches } : {}),
          agentInstruction:
            titleQuery && matches > 1
              ? "标题匹配到多条，已返回最新的一条。若不是用户想要的，请用更精确的标题重试。请向用户展示正文。"
              : "请向用户展示报告正文。",
        });
      },
    };
  };
}
