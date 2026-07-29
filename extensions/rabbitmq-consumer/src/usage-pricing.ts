import { resolveSessionTurnCurrencyPolicy, type SessionTurnCurrencyPolicy } from "../api.js";

/**
 * Per-turn cost is computed from the unit prices in
 * `models.providers.*.models[].cost`, which the operator enters in whatever
 * currency each vendor bills in — Chinese vendors (qwen/DashScope, 火山方舟,
 * DeepSeek…) quote CNY, US vendors (MiniMax open platform, Anthropic, OpenAI…)
 * quote USD. history_messages stores ONE currency, so costs from providers in
 * `foreignProviders` are multiplied by `rate` before being summed.
 *
 * Configure per deployment under the plugin's `usageCost` config key:
 *
 * ```json
 * "usageCost": {
 *   "currency": "CNY",
 *   "rate": 7,
 *   "foreignProviders": ["minimax", "anthropic", "openai"]
 * }
 * ```
 *
 * Defaults (CNY, rate 7, a built-in USD vendor list) live in the SDK; this only
 * layers env-var fallbacks on top for container deployments that cannot edit
 * openclaw.json.
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
