import {
  collectSessionTurnUsage,
  convertSessionTurnCost,
  hasSessionTurnUsage,
  primarySessionTurnModel,
  resolveSessionTurnCurrencyPolicy,
  type OpenClawConfig,
  type PluginLogger,
  type SessionTurnCurrencyPolicy,
  type SessionTurnUsage,
} from "../../api.js";

/**
 * Token/cost accounting for runs that no chat turn is waiting on — today the
 * scheduler's agent_prompt action, which burns exactly as many tokens as a
 * conversational turn but is invisible to the rabbitmq chat pipeline that does
 * the billing for chat.
 *
 * Same numbers, same currency policy, same history_messages columns as
 * `extensions/rabbitmq-consumer`'s turn-usage-writer — but computed BEFORE the
 * row exists rather than after: a scheduled run's history row is only inserted
 * once the reply is ready (see transports/db-history.ts), so the usage rides
 * along on the Notification and lands in the INSERT instead of a later UPDATE.
 */

/**
 * How long to wait before re-reading the transcript when the first pass finds no
 * model calls. The run is done by the time we look, but the transcript write is
 * a separate async append, so a fast turn can be scanned before its last
 * assistant entry has landed on disk.
 */
const SETTLE_DELAY_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One run's accounting, shaped for the history_messages token/cost columns. */
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
  /** Currency the cost fields are folded into (see the policy). */
  currency: string;
  /** Provider/model that dominated the run by cost, for the row's label. */
  provider?: string;
  model?: string;
  /** Model calls observed — one turn is N calls (the model runs again per tool result). */
  calls: number;
  /** Per-model breakdown, stored as `metadata.usage` for later auditing. */
  detail: Record<string, unknown>;
}

/**
 * Resolve the currency policy from the plugin config, falling back to the same
 * env vars `extensions/rabbitmq-consumer` reads so both writers fold costs into
 * the same currency without the operator configuring it twice.
 */
export function resolveUsageCurrencyPolicy(
  pluginConfig: Record<string, unknown> | undefined,
): SessionTurnCurrencyPolicy {
  const raw = (pluginConfig?.usageCost as Record<string, unknown> | undefined) ?? {};
  return resolveSessionTurnCurrencyPolicy({
    currency: raw.currency ?? process.env.USAGE_COST_CURRENCY,
    rate: raw.rate ?? process.env.USAGE_COST_RATE,
    foreignProviders: raw.foreignProviders ?? process.env.USAGE_COST_FOREIGN_PROVIDERS,
  });
}

/** Compact per-model detail kept in history_messages.metadata for auditing. */
function buildUsageMetadata(usage: SessionTurnUsage, record: TurnUsageRecord) {
  return {
    currency: record.currency,
    calls: usage.calls,
    // Marks the row as a scheduled run rather than a user-initiated turn, so a
    // billing rollup can tell "the assistant spent this on its own" apart from
    // "the user asked for this".
    source: "schedule",
    // How the run ended. `ok` here; a fire that spent tokens without producing
    // a reply is restamped by markUsageOutcome, so wasted spend is queryable
    // (metadata->>'$.usage.outcome' <> 'ok').
    outcome: "ok",
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.totalTokens,
    },
    cost: {
      input: record.inputCost,
      output: record.outputCost,
      cacheRead: record.cacheReadCost,
      cacheWrite: record.cacheWriteCost,
      total: record.totalCost,
    },
    // Per-model costs stay in each provider's own pricing currency; only the
    // aggregate above is normalized. Kept so a later audit can recheck the
    // conversion without re-reading the transcript.
    models: usage.models.map((m) => ({
      provider: m.provider,
      model: m.model,
      calls: m.calls,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      total: m.totalTokens,
      nativeCost: m.cost.total,
    })),
    ...(usage.missingCost ? { missingCost: true } : {}),
  };
}

export type CollectTurnUsageParams = {
  /** Session the run executed in (the derived `…:sched` key, not the chat one). */
  sessionKey: string;
  /** Agent whose sessions directory holds the transcript. */
  agentId: string;
  /** Timestamp captured immediately before `subagent.run`. */
  sinceMs: number;
  policy: SessionTurnCurrencyPolicy;
  /** Live config, for pricing fallback when a provider reports no cost. */
  config?: OpenClawConfig;
  logger: PluginLogger;
};

/**
 * Read back what one run actually cost.
 *
 * Returns undefined when the transcript has no usable usage (never throws):
 * accounting must never turn a completed run into a failed one.
 */
export async function collectTurnUsage(
  params: CollectTurnUsageParams,
): Promise<TurnUsageRecord | undefined> {
  const { sessionKey, agentId, sinceMs, policy, config, logger } = params;
  try {
    let usage = await collectSessionTurnUsage({ sessionKey, agentId, sinceMs, config });
    if (!hasSessionTurnUsage(usage)) {
      await sleep(SETTLE_DELAY_MS);
      usage = await collectSessionTurnUsage({ sessionKey, agentId, sinceMs, config });
    }
    if (!hasSessionTurnUsage(usage)) {
      logger.warn(`[LEADING_V2_USAGE] No usage found for sessionKey=${sessionKey}; not billed`);
      return undefined;
    }

    const cost = convertSessionTurnCost(usage, policy);
    const primary = primarySessionTurnModel(usage);
    const record: TurnUsageRecord = {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      inputCost: cost.input,
      outputCost: cost.output,
      cacheReadCost: cost.cacheRead,
      cacheWriteCost: cost.cacheWrite,
      totalCost: cost.total,
      currency: cost.currency,
      provider: primary?.provider,
      model: primary?.model,
      calls: usage.calls,
      detail: {},
    };
    record.detail = buildUsageMetadata(usage, record);
    return record;
  } catch (error) {
    logger.warn(`[LEADING_V2_USAGE] Usage accounting failed (non-fatal): ${String(error)}`);
    return undefined;
  }
}

/**
 * Restamp how the run ended (`timeout`, `error`, `empty-reply`). Returns a new
 * record — the original stays whatever it was.
 */
export function markUsageOutcome(usage: TurnUsageRecord, outcome: string): TurnUsageRecord {
  return { ...usage, detail: { ...usage.detail, outcome } };
}

/** One-line summary for logs, so a run is auditable even when nothing persists it. */
export function formatUsage(usage: TurnUsageRecord): string {
  return (
    `calls=${usage.calls} in=${usage.inputTokens} out=${usage.outputTokens} ` +
    `cacheRead=${usage.cacheReadTokens} cacheWrite=${usage.cacheWriteTokens} ` +
    `cost=${usage.totalCost.toFixed(6)} ${usage.currency} ` +
    `model=${usage.provider ?? "?"}/${usage.model ?? "?"}`
  );
}
