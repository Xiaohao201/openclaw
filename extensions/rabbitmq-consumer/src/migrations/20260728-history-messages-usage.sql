-- Per-turn LLM token/cost accounting on history_messages
-- ---------------------------------------------------------------------------
-- Purpose
--   Record what each conversation turn actually consumed and cost, so usage can
--   be reported and billed per user / per period straight from the chat history
--   table instead of being reconstructed from agent session transcripts.
--
--   Written by:
--     * extensions/rabbitmq-consumer  — the conversational turn itself
--       (HistoryManager.addUsage, called from chat-pipeline Step 7c)
--     * extensions/report-generator   — the asynchronous report generated for
--       that same turn (ReportHistoryWriter.writeUsage)
--
--   Both writers ACCUMULATE (`col = COALESCE(col, 0) + ?`). A row that produced
--   a reply and then a report therefore ends up holding the FULL cost of serving
--   that user message. Re-running a turn is prevented upstream by the pipeline's
--   idempotency check (a row that already has `response` is skipped), so the
--   accumulation cannot double-count a retried message.
--
-- Token semantics (as reported by the provider, normalized by OpenClaw)
--   input_tokens        uncached prompt tokens
--   cache_read_tokens   prompt tokens served from the provider's context cache
--   cache_write_tokens  prompt tokens written INTO that cache
--   output_tokens       generated tokens
--   total_tokens        provider total when reported, else the sum of the parts
--
--   The three prompt-side counters are disjoint: full prompt size is
--   input + cache_read + cache_write. They are stored separately because each is
--   priced differently (a cache read is typically ~10-20% of the input price,
--   which is exactly why cached turns must not be billed at the input rate).
--
--   One turn is usually SEVERAL model calls — the agent is called again after
--   every tool result — so these are sums over the whole turn and `llm_calls`
--   records how many calls that was.
--
-- Cost semantics
--   Costs come from the per-million unit prices configured in
--   `models.providers.*.models[].cost` (openclaw.json), preferring the cost the
--   provider itself reported for the call when it reports one.
--
--   Vendors quote in different currencies (Chinese vendors in CNY, US vendors in
--   USD), so the writers fold everything into ONE currency before storing it —
--   see the plugin `usageCost` config key. `cost_currency` records which
--   currency the amounts are in ('CNY' by default); it is stamped on every write
--   so a later currency switch is visible in the data rather than silent.
--
--   DECIMAL(16,8) — never FLOAT: money must not accumulate binary rounding
--   error, and 8 decimal places keeps a sub-0.01-token call from rounding to 0.
--
-- Safety
--   All columns are appended, nullable-free with defaults, so MySQL 8 performs
--   this with ALGORITHM=INSTANT (no table rebuild, no lock) and existing rows
--   read back as zeros. No existing column is touched.
--
-- Requires ALTER privilege — the runtime `btclaw_writer` account has only
-- SELECT/INSERT/UPDATE, so run this once with an administrative account:
--
--   mysql -h <host> -u <admin> -p superworker < 20260728-history-messages-usage.sql
--
-- NOT idempotent: MySQL 8 has no `ADD COLUMN IF NOT EXISTS`. Running it twice
-- fails with "Duplicate column name"; that is harmless (the first run stands).
-- ---------------------------------------------------------------------------

ALTER TABLE `history_messages`
  ADD COLUMN `input_tokens`       INT UNSIGNED    NOT NULL DEFAULT 0
      COMMENT '本轮全部模型调用的非缓存输入 token 合计',
  ADD COLUMN `output_tokens`      INT UNSIGNED    NOT NULL DEFAULT 0
      COMMENT '本轮全部模型调用的输出 token 合计',
  ADD COLUMN `cache_read_tokens`  INT UNSIGNED    NOT NULL DEFAULT 0
      COMMENT '命中上下文缓存的输入 token 合计（单价远低于 input）',
  ADD COLUMN `cache_write_tokens` INT UNSIGNED    NOT NULL DEFAULT 0
      COMMENT '写入上下文缓存的输入 token 合计',
  ADD COLUMN `total_tokens`       INT UNSIGNED    NOT NULL DEFAULT 0
      COMMENT 'token 总量（厂商上报的 total，缺失时为各项之和）',
  ADD COLUMN `input_cost`         DECIMAL(16, 8)  NOT NULL DEFAULT 0
      COMMENT '非缓存输入费用，币种见 cost_currency',
  ADD COLUMN `output_cost`        DECIMAL(16, 8)  NOT NULL DEFAULT 0
      COMMENT '输出费用，币种见 cost_currency',
  ADD COLUMN `cache_read_cost`    DECIMAL(16, 8)  NOT NULL DEFAULT 0
      COMMENT '缓存读取费用，币种见 cost_currency',
  ADD COLUMN `cache_write_cost`   DECIMAL(16, 8)  NOT NULL DEFAULT 0
      COMMENT '缓存写入费用，币种见 cost_currency',
  ADD COLUMN `total_cost`         DECIMAL(16, 8)  NOT NULL DEFAULT 0
      COMMENT '本轮总费用 = 上述四项之和，币种见 cost_currency',
  ADD COLUMN `cost_currency`      VARCHAR(8)      NOT NULL DEFAULT 'CNY'
      COMMENT '费用列的币种，各厂商单价已统一折算到此币种',
  ADD COLUMN `llm_provider`       VARCHAR(64)     NULL DEFAULT NULL
      COMMENT '本轮费用占比最高的供应商，如 qwen / minimax',
  ADD COLUMN `llm_model`          VARCHAR(128)    NULL DEFAULT NULL
      COMMENT '本轮费用占比最高的模型，如 qwen3.6-plus',
  ADD COLUMN `llm_calls`          SMALLINT UNSIGNED NOT NULL DEFAULT 0
      COMMENT '本轮实际发生的模型调用次数（每轮工具调用后会再次请求模型）',
  ALGORITHM = INSTANT;

-- Per-user / per-period billing rollups scan by user and time. The table has
-- only a PRIMARY KEY today, so without this every rollup is a full scan.
ALTER TABLE `history_messages`
  ADD INDEX `idx_user_created` (`user_id`, `created_at`);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- SHOW COLUMNS FROM `history_messages` LIKE '%token%';
-- SHOW COLUMNS FROM `history_messages` LIKE '%cost%';
--
-- Recent turns with their real usage:
--   SELECT id, user_id, llm_provider, llm_model, llm_calls,
--          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
--          total_tokens, total_cost, cost_currency, created_at
--     FROM history_messages
--    WHERE total_tokens > 0
--    ORDER BY id DESC
--    LIMIT 20;
--
-- Cost per user for a month:
--   SELECT user_id,
--          SUM(input_tokens)  AS input_tokens,
--          SUM(cache_read_tokens) AS cache_read_tokens,
--          SUM(output_tokens) AS output_tokens,
--          SUM(total_cost)    AS total_cost,
--          MAX(cost_currency) AS currency,
--          COUNT(*)           AS turns
--     FROM history_messages
--    WHERE created_at >= '2026-07-01' AND created_at < '2026-08-01'
--    GROUP BY user_id
--    ORDER BY total_cost DESC;
--
-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- ALTER TABLE `history_messages`
--   DROP INDEX `idx_user_created`,
--   DROP COLUMN `input_tokens`,
--   DROP COLUMN `output_tokens`,
--   DROP COLUMN `cache_read_tokens`,
--   DROP COLUMN `cache_write_tokens`,
--   DROP COLUMN `total_tokens`,
--   DROP COLUMN `input_cost`,
--   DROP COLUMN `output_cost`,
--   DROP COLUMN `cache_read_cost`,
--   DROP COLUMN `cache_write_cost`,
--   DROP COLUMN `total_cost`,
--   DROP COLUMN `cost_currency`,
--   DROP COLUMN `llm_provider`,
--   DROP COLUMN `llm_model`,
--   DROP COLUMN `llm_calls`;
