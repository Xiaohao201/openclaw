import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi, type PluginRuntime } from "../api.js";
import { isNewsMedia } from "./media-whitelist.js";
import { collectAssistantTexts } from "./message-text.js";
import {
  buildRiskJudgeSystemPrompt,
  buildRiskJudgeUserMessage,
  parseRiskResult,
} from "./rubric.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PRECEDENT_COLLECTION = "risk_judge_cases";
const DEFAULT_PRECEDENT_TOP_K = 5;
/** Generous enough to cover a search + upsert tool-call round-trip within one turn. */
const SESSION_MESSAGES_LIMIT = 20;

/**
 * The gateway publishes its real subagent runtime onto this process-global at
 * startup (see core `setGatewaySubagentRuntime`). We read it directly because a
 * plugin TOOL invoked inside a live chat turn frequently gets a request-scoped
 * runtime whose `api.runtime.subagent` is an UNAVAILABLE stub — calling `.run()`
 * on it throws RequestScopedSubagentRuntimeError, which surfaced to the user as
 * "风险研判工具暂时不可用". The core late-binding proxy reads the same global; we
 * just resolve it explicitly so this tool works regardless of whether our
 * plugin's registry happened to be loaded with gateway-subagent binding.
 */
const GATEWAY_SUBAGENT_SYMBOL = Symbol.for("openclaw.plugin.gatewaySubagentRuntime");

/** Prefer the gateway-published subagent; fall back to the tool-context runtime. */
function resolveSubagent(api: OpenClawPluginApi): PluginRuntime["subagent"] | undefined {
  const holder = (globalThis as Record<PropertyKey, unknown>)[GATEWAY_SUBAGENT_SYMBOL] as
    | { subagent?: PluginRuntime["subagent"] }
    | undefined;
  return holder?.subagent ?? api.runtime?.subagent;
}

const RiskJudgeSchema = Type.Object(
  {
    content: Type.String({
      description:
        "The 舆情 to grade: the pasted text/headline, OR a public URL (its slug often carries the headline). " +
        "Required.",
    }),
    author: Type.Optional(
      Type.String({
        description:
          "Publishing account / outlet name, if known. Used to check the authoritative media whitelist (标准①).",
      }),
    ),
    title: Type.Optional(Type.String({ description: "Headline / 标题, if known. Optional." })),
  },
  { additionalProperties: false },
);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface RiskJudgeConfig {
  timeoutMs: number;
  enablePrecedentRag: boolean;
  precedentCollection: string;
  precedentTopK: number;
}

function resolveConfig(raw: Record<string, unknown>): RiskJudgeConfig {
  const t = raw.timeoutMs;
  const topK = raw.precedentTopK;
  const collection = raw.precedentCollection;
  return {
    timeoutMs: typeof t === "number" && t > 0 ? t : DEFAULT_TIMEOUT_MS,
    enablePrecedentRag: raw.enablePrecedentRag === true,
    precedentCollection:
      typeof collection === "string" && collection.trim()
        ? collection.trim()
        : DEFAULT_PRECEDENT_COLLECTION,
    precedentTopK: typeof topK === "number" && topK > 0 ? topK : DEFAULT_PRECEDENT_TOP_K,
  };
}

/** Milvus collection names are restricted to `[a-zA-Z0-9_]`; sanitize an agentId into a safe suffix. */
function sanitizeCollectionSuffix(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Per-tenant collection name so historical cases from one agent never leak into another's precedent search. */
function resolvePrecedentCollection(config: RiskJudgeConfig, agentId: string | undefined): string {
  if (!agentId) {
    return config.precedentCollection;
  }
  return `${config.precedentCollection}_${sanitizeCollectionSuffix(agentId)}`;
}

/**
 * Factory for the `risk_judge` tool. Captures `api` so `execute` can reach the
 * configured model via `api.runtime.subagent`. The rubric runs in an isolated,
 * non-delivered subagent session so the grade is reproducible and never leaks
 * the internal标准 into the conversation.
 */
export function createRiskJudgeToolFactory(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string; sessionId?: string }) => {
    return {
      name: "risk_judge",
      label: "舆情风险研判",
      description:
        "对一段舆情内容做标准化风险研判：套用资深网信办分析师的 3 标准 / 5 级评级规则（蓝/黄/橙/红/高危预警）" +
        "并结合权威媒体白名单，产出风险等级、判定依据、风险特征与处置建议。" +
        "当用户要求对某条舆情/链接/文本进行『风险研判』『判定风险等级』『处置建议』时调用本工具，" +
        "不要自行凭空判定等级。",
      parameters: RiskJudgeSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const content = asString(rawParams.content);
        if (!content) {
          return jsonResult({
            success: false,
            error: "content is required (the 舆情 text/headline or a URL).",
          });
        }
        const author = asString(rawParams.author);
        const title = asString(rawParams.title);
        const authorIsMedia = isNewsMedia(author);

        const subagent = resolveSubagent(api);
        if (!subagent) {
          api.logger.error("[RISK_JUDGE] subagent runtime unavailable");
          return jsonResult({ success: false, error: "Model runtime is unavailable." });
        }

        const agentPart = ctx.agentId ? `agent:${ctx.agentId}:` : "";
        const sessionKey = `${agentPart}risk-judge:${ctx.sessionId ?? "adhoc"}:${Date.now()}`;
        const userMessage = buildRiskJudgeUserMessage({ content, author, title, authorIsMedia });
        const extraSystemPrompt = buildRiskJudgeSystemPrompt(
          config.enablePrecedentRag
            ? {
                rag: {
                  collection: resolvePrecedentCollection(config, ctx.agentId),
                  topK: config.precedentTopK,
                },
              }
            : {},
        );

        try {
          const run = await subagent.run({
            sessionKey,
            message: userMessage,
            extraSystemPrompt,
            deliver: false,
          });
          const wait = await subagent.waitForRun({
            runId: run.runId,
            timeoutMs: config.timeoutMs,
          });
          if (wait.status !== "ok") {
            api.logger.warn(`[RISK_JUDGE] subagent ${wait.status}: ${wait.error ?? ""}`);
            return jsonResult({
              success: false,
              error:
                wait.status === "timeout" ? "研判超时，请稍后重试或人工研判。" : "研判生成失败。",
            });
          }

          const session = await subagent.getSessionMessages({
            sessionKey,
            limit: SESSION_MESSAGES_LIMIT,
          });
          // In a tool-using turn the final assistant message may be a closing
          // remark (e.g. after a milvus_upsert call) rather than the JSON
          // answer, so try each assistant text in order until one parses.
          const parsed = collectAssistantTexts(session.messages)
            .map((text) => parseRiskResult(text))
            .find((result): result is NonNullable<typeof result> => result !== null);
          if (!parsed) {
            api.logger.warn("[RISK_JUDGE] could not parse a risk level from model output");
            return jsonResult({ success: false, error: "未能从模型输出中解析出风险等级。" });
          }

          return jsonResult({
            success: true,
            risk_level: parsed.riskLevel,
            report_markdown: parsed.reportMarkdown,
            author_is_media: authorIsMedia,
          });
        } catch (error) {
          api.logger.error(`[RISK_JUDGE] execute failed: ${String(error)}`);
          return jsonResult({ success: false, error: "研判过程中发生错误。" });
        } finally {
          // Best-effort cleanup of the ephemeral grading session.
          try {
            await subagent.deleteSession({ sessionKey });
          } catch {
            // ignore — session GC is not critical to the result
          }
        }
      },
    };
  };
}
