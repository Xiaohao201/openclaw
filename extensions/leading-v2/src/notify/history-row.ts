import type { PluginLogger } from "../../api.js";
import { execute } from "../client/db-client.js";
import type { MySqlConfig } from "../client/types.js";
import type { TurnUsageRecord } from "./usage.js";

/**
 * Writes to history_messages — the table the web chat renders from and the
 * admin usage page bills from. One row = one round.
 *
 * A row is written with `message` empty (nobody asked; the instruction lives in
 * schedule_tasks), which is exactly how the usage page classifies a round as
 * `kind: schedule`. An EMPTY `response` on top of that makes the row invisible
 * in chat — the history loader emits a user bubble only for a non-empty
 * `message` and an assistant bubble only for a non-empty `response` — while
 * still carrying its token/cost columns. That is how a scheduled run that
 * burned tokens but produced nothing gets billed without spamming the user.
 */

/**
 * MySQL error code for a column that does not exist. The token/cost columns
 * come from a separate migration; on a database that has not had it applied,
 * the usage write must degrade to a plain row rather than lose the message.
 */
const ER_BAD_FIELD_ERROR = "ER_BAD_FIELD_ERROR";

/** Latched after the first miss so an un-migrated table warns once, not hourly. */
let usageColumnsMissing = false;

/** Test seam: reset the process-wide latch. */
export function resetUsageColumnSupport(): void {
  usageColumnsMissing = false;
}

/** DECIMAL(16,8) in the schema — round here so MySQL never truncates silently. */
const roundCost = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : 0;

/** INT UNSIGNED in the schema — no negatives, no fractions. */
const roundTokens = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const BASE_COLUMNS = "session_id, user_id, message, response, tools_used, metadata, created_at";

const PLAIN_SQL = `INSERT INTO history_messages (${BASE_COLUMNS}) VALUES (?, ?, '', ?, NULL, ?, NOW())`;

const USAGE_SQL =
  `INSERT INTO history_messages (${BASE_COLUMNS}, ` +
  "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, " +
  "input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, " +
  "cost_currency, llm_provider, llm_model, llm_calls) " +
  "VALUES (?, ?, '', ?, NULL, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** Column values for the usage-carrying insert, in USAGE_SQL's placeholder order. */
function usageParams(usage: TurnUsageRecord): unknown[] {
  return [
    roundTokens(usage.inputTokens),
    roundTokens(usage.outputTokens),
    roundTokens(usage.cacheReadTokens),
    roundTokens(usage.cacheWriteTokens),
    roundTokens(usage.totalTokens),
    roundCost(usage.inputCost),
    roundCost(usage.outputCost),
    roundCost(usage.cacheReadCost),
    roundCost(usage.cacheWriteCost),
    roundCost(usage.totalCost),
    usage.currency,
    usage.provider ?? null,
    usage.model ?? null,
    roundTokens(usage.calls),
  ];
}

/** Pull the chat sessionId out of an agent sessionKey (…:<sessionId> tail). */
export function sessionIdFromKey(sessionKey?: string): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const tail = sessionKey.split(":").pop();
  return tail && tail.startsWith("session_") ? tail : undefined;
}

export type HistoryRowInsert = {
  sessionId: string;
  uid: string;
  /** Assistant bubble text; empty writes an accounting-only (invisible) row. */
  response: string;
  /** Token/cost of the run behind this row, when an LLM produced it. */
  usage?: TurnUsageRecord;
};

/**
 * Insert one assistant-side history row, with its token/cost columns when the
 * run was billed. Throws on a real database failure — callers decide whether
 * that should fail their flow.
 */
export async function insertHistoryRow(
  db: MySqlConfig,
  row: HistoryRowInsert,
  logger?: PluginLogger,
): Promise<void> {
  const metadata = row.usage ? JSON.stringify({ usage: row.usage.detail }) : null;
  const base = [row.sessionId, row.uid, row.response, metadata];

  if (row.usage && !usageColumnsMissing) {
    try {
      await execute(db, USAGE_SQL, [...base, ...usageParams(row.usage)]);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== ER_BAD_FIELD_ERROR) {
        throw error;
      }
      // Nothing was inserted, so falling through to the plain insert below
      // cannot duplicate the row.
      usageColumnsMissing = true;
      logger?.warn(
        "[LEADING_V2_NOTIFY] history_messages is missing the token/cost columns; " +
          "scheduled runs cannot be billed until they are added (input_tokens, " +
          "output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, " +
          "input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, " +
          "cost_currency, llm_provider, llm_model, llm_calls)",
      );
    }
  }

  await execute(db, PLAIN_SQL, base);
}
