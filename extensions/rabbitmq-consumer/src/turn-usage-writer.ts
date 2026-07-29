import {
  collectSessionTurnUsage,
  convertSessionTurnCost,
  hasSessionTurnUsage,
  primarySessionTurnModel,
  type OpenClawConfig,
  type PluginLogger,
  type SessionTurnCurrencyPolicy,
  type SessionTurnUsage,
} from "../api.js";
import type { HistoryManager } from "./history-manager.js";
import type { TurnUsageRecord } from "./types.js";

/**
 * How long to wait before re-reading the transcript when the first pass finds
 * no model calls. The run is done by the time we look, but the transcript write
 * is a separate async append, so a fast turn can occasionally be scanned before
 * its last assistant entry has landed on disk.
 */
const SETTLE_DELAY_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Compact per-model detail kept in history_messages.metadata for auditing. */
function buildUsageMetadata(usage: SessionTurnUsage, record: TurnUsageRecord) {
  return {
    currency: record.currency,
    calls: usage.calls,
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

export type PersistTurnUsageArgs = {
  historyId: number;
  /** Session the run executed in. */
  sessionKey: string;
  agentId: string;
  /** Timestamp captured immediately before `subagent.run`. */
  sinceMs: number;
  historyManager: HistoryManager;
  policy: SessionTurnCurrencyPolicy;
  /** Live config, for pricing fallback when a provider reports no cost. */
  config?: OpenClawConfig;
  logger: PluginLogger;
  /** metadata key for the per-model detail; distinct per writer so they merge. */
  metadataKey?: string;
};

/**
 * Read back what this turn actually cost and write it onto the history row.
 *
 * Runs after the agent finished (including error/timeout exits — the tokens
 * were spent either way). Fully best-effort: every failure is logged and
 * swallowed, because the user already has their answer and a billing write must
 * never turn a successful turn into an error.
 */
export async function persistTurnUsage(args: PersistTurnUsageArgs): Promise<void> {
  const { historyId, sessionKey, agentId, sinceMs, historyManager, policy, config, logger } = args;
  try {
    let usage = await collectSessionTurnUsage({ sessionKey, agentId, sinceMs, config });
    if (!hasSessionTurnUsage(usage)) {
      await sleep(SETTLE_DELAY_MS);
      usage = await collectSessionTurnUsage({ sessionKey, agentId, sinceMs, config });
    }
    if (!hasSessionTurnUsage(usage)) {
      logger.warn(
        `[TURN_USAGE] No usage found for historyId=${historyId} (sessionKey=${sessionKey}); skipping`,
      );
      return;
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
    };

    await historyManager.addUsage(historyId, record);
    logger.info(
      `[TURN_USAGE] historyId=${historyId} calls=${record.calls} ` +
        `in=${record.inputTokens} out=${record.outputTokens} ` +
        `cacheRead=${record.cacheReadTokens} cacheWrite=${record.cacheWriteTokens} ` +
        `cost=${record.totalCost.toFixed(6)} ${record.currency} ` +
        `model=${record.provider ?? "?"}/${record.model ?? "?"}`,
    );

    try {
      await historyManager.updateMetadata(historyId, {
        [args.metadataKey ?? "usage"]: buildUsageMetadata(usage, record),
      });
    } catch (metaErr) {
      logger.warn(`[TURN_USAGE] Persist usage metadata failed (non-fatal): ${String(metaErr)}`);
    }
  } catch (err) {
    logger.warn(`[TURN_USAGE] Usage accounting failed (non-fatal): ${String(err)}`);
  }
}
