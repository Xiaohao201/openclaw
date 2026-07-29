import fs from "node:fs";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { normalizeStoreSessionKey } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveModelCostConfig } from "../utils/usage-format.js";
import {
  resolveExistingUsageSessionFile,
  scanSessionTranscriptEntries,
} from "./session-cost-usage.js";

/**
 * Per-turn (single agent run) token/cost accounting.
 *
 * `loadSessionCostSummary` in `session-cost-usage.ts` answers "what has this
 * whole session cost so far". Billing a single chat turn needs the delta: one
 * turn is N assistant messages (the model is called again after every tool
 * result), all appended to the same transcript while the run is in flight. So a
 * turn is isolated by time window — every assistant entry written at or after
 * the moment the run was started.
 *
 * Costs stay in the currency each provider's configured unit price is written
 * in (`models.providers.*.models[].cost`, per million tokens). Providers can be
 * priced in different currencies, so a cross-provider sum is only meaningful
 * after `convertSessionTurnCost` normalizes them to one currency.
 */

export type SessionTurnTokenTotals = {
  /** Number of model calls (assistant messages) observed in the window. */
  calls: number;
  /** Uncached prompt tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported total when present, else the sum of the parts. */
  totalTokens: number;
};

export type SessionTurnCostParts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type SessionTurnModelUsage = SessionTurnTokenTotals & {
  provider?: string;
  model?: string;
  /** Cost in the currency this model's configured unit price uses. */
  cost: SessionTurnCostParts;
  /** True when at least one call had no usable pricing, so `cost` under-counts. */
  missingCost: boolean;
};

export type SessionTurnUsage = SessionTurnTokenTotals & {
  /** Per provider/model breakdown, sorted by `provider::model` for determinism. */
  models: SessionTurnModelUsage[];
  /** True when any call in the window had no usable pricing. */
  missingCost: boolean;
};

export type SessionTurnCost = SessionTurnCostParts & {
  currency: string;
  missingCost: boolean;
};

/**
 * How to fold per-provider costs into one reporting currency.
 *
 * Unit prices are entered by the operator in whatever currency the provider
 * bills in (Chinese vendors quote CNY, US vendors quote USD), so the provider
 * ids in `foreignProviders` are the ones needing `rate` applied; everything
 * else is assumed to already be in `currency`.
 */
export type SessionTurnCurrencyPolicy = {
  /** Target currency label, e.g. "CNY". */
  currency: string;
  /** Multiplier applied to `foreignProviders` costs (e.g. USD→CNY = 7). */
  rate: number;
  /** Provider ids whose configured unit prices are NOT in `currency`. */
  foreignProviders: readonly string[];
};

const emptyCost = (): SessionTurnCostParts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

const emptyTokens = (): SessionTurnTokenTotals => ({
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});

/** Empty (all-zero) usage, so callers never have to branch on null. */
export function emptySessionTurnUsage(): SessionTurnUsage {
  return { ...emptyTokens(), models: [], missingCost: false };
}

export function hasSessionTurnUsage(usage: SessionTurnUsage | null | undefined): boolean {
  return Boolean(usage && (usage.calls > 0 || usage.totalTokens > 0));
}

/**
 * Resolve the transcript file backing a sessionKey. The session store maps
 * sessionKey -> sessionId; the transcript lives next to the store.
 */
function resolveTranscriptFileForSessionKey(params: {
  sessionKey: string;
  agentId?: string;
  storePath?: string;
}): string | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  let entry: SessionEntry | undefined;
  try {
    // skipCache: the run just wrote this session; a cached store can predate it.
    const store = loadSessionStore(storePath, { skipCache: true });
    entry = store[normalizeStoreSessionKey(sessionKey)] ?? store[sessionKey];
  } catch {
    return undefined;
  }
  if (!entry?.sessionId) {
    return undefined;
  }
  // Resolve relative to the store we actually read, so an explicit storePath
  // (tests, non-default layouts) points at that directory's transcripts rather
  // than the default agent's.
  const sessionFile = resolveSessionFilePath(
    entry.sessionId,
    entry,
    resolveSessionFilePathOptions({ agentId: params.agentId, storePath }),
  );
  const file = resolveExistingUsageSessionFile({
    sessionId: entry.sessionId,
    sessionEntry: entry,
    sessionFile,
    agentId: params.agentId,
  });
  return file && fs.existsSync(file) ? file : undefined;
}

/**
 * Cost parts for one call. Providers that report a cost breakdown win (it is
 * what they actually billed); otherwise fall back to the configured per-million
 * unit price, which is also the only source for a per-part breakdown.
 */
function resolveCallCost(params: {
  provider?: string;
  model?: string;
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  reported?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  config?: OpenClawConfig;
}): SessionTurnCostParts | null {
  const reported = params.reported;
  if (reported?.total !== undefined) {
    const input = reported.input ?? 0;
    const output = reported.output ?? 0;
    const cacheRead = reported.cacheRead ?? 0;
    const cacheWrite = reported.cacheWrite ?? 0;
    // Some providers report only a total; keep it rather than dropping to the
    // (possibly missing) configured price, and attribute it to input so the
    // parts still sum to the total.
    const parts = input + output + cacheRead + cacheWrite;
    if (parts === 0 && reported.total > 0) {
      return {
        input: reported.total,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: reported.total,
      };
    }
    return { input, output, cacheRead, cacheWrite, total: reported.total };
  }

  const unit = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.config,
  });
  if (!unit) {
    return null;
  }
  const input = ((params.usage.input ?? 0) * unit.input) / 1_000_000;
  const output = ((params.usage.output ?? 0) * unit.output) / 1_000_000;
  const cacheRead = ((params.usage.cacheRead ?? 0) * unit.cacheRead) / 1_000_000;
  const cacheWrite = ((params.usage.cacheWrite ?? 0) * unit.cacheWrite) / 1_000_000;
  const total = input + output + cacheRead + cacheWrite;
  return Number.isFinite(total) ? { input, output, cacheRead, cacheWrite, total } : null;
}

export type CollectSessionTurnUsageParams = {
  /** Session the run executed in (as passed to `subagent.run`). */
  sessionKey: string;
  /** Agent whose sessions directory holds the transcript. */
  agentId?: string;
  /** Start of the turn window: entries older than this are other turns. */
  sinceMs: number;
  /** End of the window; defaults to open-ended. */
  untilMs?: number;
  /** Live config, for pricing fallback when the provider reports no cost. */
  config?: OpenClawConfig;
  /** Override the session store path (tests). */
  storePath?: string;
};

/**
 * Sum token usage and cost for every model call a single run appended to its
 * session transcript.
 *
 * Returns all-zero usage (never throws) when the transcript, session mapping,
 * or usage data is unavailable — usage accounting must never fail a turn that
 * already produced an answer.
 */
export async function collectSessionTurnUsage(
  params: CollectSessionTurnUsageParams,
): Promise<SessionTurnUsage> {
  const result = emptySessionTurnUsage();
  const filePath = resolveTranscriptFileForSessionKey({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    storePath: params.storePath,
  });
  if (!filePath) {
    return result;
  }

  const byModel = new Map<string, SessionTurnModelUsage>();

  try {
    await scanSessionTranscriptEntries({
      filePath,
      config: params.config,
      onEntry: (entry) => {
        if (entry.role !== "assistant" || !entry.usage) {
          return;
        }
        const ts = entry.timestamp?.getTime();
        // An entry with no timestamp cannot be placed in the window; counting it
        // would attribute another turn's tokens to this one.
        if (ts === undefined || ts < params.sinceMs) {
          return;
        }
        if (params.untilMs !== undefined && ts > params.untilMs) {
          return;
        }

        const input = entry.usage.input ?? 0;
        const output = entry.usage.output ?? 0;
        const cacheRead = entry.usage.cacheRead ?? 0;
        const cacheWrite = entry.usage.cacheWrite ?? 0;
        const totalTokens = entry.usage.total ?? input + output + cacheRead + cacheWrite;
        // Delivery mirrors and other bookkeeping rows carry an all-zero usage
        // snapshot; they are not model calls and must not inflate the count.
        if (totalTokens <= 0) {
          return;
        }

        const provider = normalizeOptionalString(entry.provider);
        const model = normalizeOptionalString(entry.model);
        const key = `${provider ?? ""}::${model ?? ""}`;
        const bucket =
          byModel.get(key) ??
          ({
            provider,
            model,
            ...emptyTokens(),
            cost: emptyCost(),
            missingCost: false,
          } satisfies SessionTurnModelUsage);

        bucket.calls += 1;
        bucket.input += input;
        bucket.output += output;
        bucket.cacheRead += cacheRead;
        bucket.cacheWrite += cacheWrite;
        bucket.totalTokens += totalTokens;

        const cost = resolveCallCost({
          provider,
          model,
          usage: { input, output, cacheRead, cacheWrite },
          reported: entry.costBreakdown,
          config: params.config,
        });
        if (cost) {
          bucket.cost.input += cost.input;
          bucket.cost.output += cost.output;
          bucket.cost.cacheRead += cost.cacheRead;
          bucket.cost.cacheWrite += cost.cacheWrite;
          bucket.cost.total += cost.total;
        } else {
          bucket.missingCost = true;
        }

        byModel.set(key, bucket);
      },
    });
  } catch {
    return result;
  }

  const models = Array.from(byModel.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);

  for (const model of models) {
    result.calls += model.calls;
    result.input += model.input;
    result.output += model.output;
    result.cacheRead += model.cacheRead;
    result.cacheWrite += model.cacheWrite;
    result.totalTokens += model.totalTokens;
    result.missingCost ||= model.missingCost;
  }
  result.models = models;
  return result;
}

/** Reporting currency assumed when a deployment configures none. */
const DEFAULT_TURN_CURRENCY = "CNY";

/** Foreign-currency multiplier assumed when a deployment configures none. */
const DEFAULT_TURN_RATE = 7;

/**
 * Vendors that quote their prices in USD. Everything else is assumed to already
 * be priced in the reporting currency, which keeps the common case (a CNY-based
 * deployment adding another Chinese vendor) config-free.
 */
const DEFAULT_FOREIGN_PROVIDERS = [
  "anthropic",
  "azure",
  "bedrock",
  "cerebras",
  "deepinfra",
  "fireworks",
  "google",
  "groq",
  "minimax",
  "mistral",
  "openai",
  "openrouter",
  "together",
  "vercel-ai-gateway",
  "xai",
];

const asPositiveNumber = (value: unknown): number | undefined => {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) && num > 0 ? num : undefined;
};

const asProviderList = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!list) {
    return undefined;
  }
  const cleaned = list
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
};

/**
 * Build a currency policy from a plain config object, e.g. a plugin's
 * `usageCost` key:
 *
 * ```json
 * { "currency": "CNY", "rate": 7, "foreignProviders": ["minimax", "openai"] }
 * ```
 *
 * Never throws — a malformed field falls back to its default so a config typo
 * cannot break the flow being billed.
 */
export function resolveSessionTurnCurrencyPolicy(
  raw?: Record<string, unknown> | null,
): SessionTurnCurrencyPolicy {
  const currency = normalizeOptionalString(raw?.currency) ?? DEFAULT_TURN_CURRENCY;
  const rate = asPositiveNumber(raw?.rate) ?? DEFAULT_TURN_RATE;
  const foreignProviders = asProviderList(raw?.foreignProviders) ?? [...DEFAULT_FOREIGN_PROVIDERS];
  return { currency, rate, foreignProviders };
}

/**
 * Combine usage from several runs (e.g. a planning run plus a writing run that
 * together serve one user request) into a single total, re-merging the
 * per-model buckets so a model used by both runs stays one row.
 */
export function mergeSessionTurnUsage(
  parts: readonly (SessionTurnUsage | null | undefined)[],
): SessionTurnUsage {
  const byModel = new Map<string, SessionTurnModelUsage>();
  const result = emptySessionTurnUsage();

  for (const part of parts) {
    if (!part) {
      continue;
    }
    for (const model of part.models) {
      const key = `${model.provider ?? ""}::${model.model ?? ""}`;
      const bucket =
        byModel.get(key) ??
        ({
          provider: model.provider,
          model: model.model,
          ...emptyTokens(),
          cost: emptyCost(),
          missingCost: false,
        } satisfies SessionTurnModelUsage);
      bucket.calls += model.calls;
      bucket.input += model.input;
      bucket.output += model.output;
      bucket.cacheRead += model.cacheRead;
      bucket.cacheWrite += model.cacheWrite;
      bucket.totalTokens += model.totalTokens;
      bucket.cost.input += model.cost.input;
      bucket.cost.output += model.cost.output;
      bucket.cost.cacheRead += model.cost.cacheRead;
      bucket.cost.cacheWrite += model.cost.cacheWrite;
      bucket.cost.total += model.cost.total;
      bucket.missingCost ||= model.missingCost;
      byModel.set(key, bucket);
    }
  }

  result.models = Array.from(byModel.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
  for (const model of result.models) {
    result.calls += model.calls;
    result.input += model.input;
    result.output += model.output;
    result.cacheRead += model.cacheRead;
    result.cacheWrite += model.cacheWrite;
    result.totalTokens += model.totalTokens;
    result.missingCost ||= model.missingCost;
  }
  return result;
}

/**
 * Fold the per-model costs into one currency.
 *
 * Provider matching is case-insensitive on the provider id, so a policy listing
 * "minimax" covers the "MiniMax" spelling a transcript may carry.
 */
export function convertSessionTurnCost(
  usage: SessionTurnUsage,
  policy: SessionTurnCurrencyPolicy,
): SessionTurnCost {
  const foreign = new Set(policy.foreignProviders.map((id) => id.trim().toLowerCase()));
  const rate = Number.isFinite(policy.rate) && policy.rate > 0 ? policy.rate : 1;
  const out: SessionTurnCost = {
    currency: policy.currency,
    ...emptyCost(),
    missingCost: usage.missingCost,
  };
  for (const model of usage.models) {
    const multiplier = foreign.has((model.provider ?? "").toLowerCase()) ? rate : 1;
    out.input += model.cost.input * multiplier;
    out.output += model.cost.output * multiplier;
    out.cacheRead += model.cost.cacheRead * multiplier;
    out.cacheWrite += model.cost.cacheWrite * multiplier;
    out.total += model.cost.total * multiplier;
  }
  return out;
}

/**
 * The model that dominated a turn by cost (ties broken by tokens, then by key
 * so the pick is deterministic). Used to label a turn with a single
 * provider/model when several were involved.
 */
export function primarySessionTurnModel(
  usage: SessionTurnUsage,
): { provider?: string; model?: string } | undefined {
  let best: SessionTurnModelUsage | undefined;
  for (const model of usage.models) {
    if (
      !best ||
      model.cost.total > best.cost.total ||
      (model.cost.total === best.cost.total && model.totalTokens > best.totalTokens)
    ) {
      best = model;
    }
  }
  return best ? { provider: best.provider, model: best.model } : undefined;
}
