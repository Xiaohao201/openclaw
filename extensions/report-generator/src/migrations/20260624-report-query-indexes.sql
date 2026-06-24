-- Report query indexes for feed_monitor_item
-- ---------------------------------------------------------------------------
-- Purpose
--   Speed up the report data path (FeedCounter.countFeedData and
--   FeedCollector.collectStats), whose hot WHERE shape is always:
--
--       (topicId = ? | slaveTopicId = ?)  AND  skip = 0  AND  date >= ? AND date < ?
--
--   Equality columns first (topicId/slaveTopicId, skip), range column (date)
--   last, so MySQL can range-scan the date window inside the matched topic
--   instead of filtering a large slice row by row.
--
-- State of the table (per extensions/report-generator/src/feed_monitor_item.sql)
--   * `idx_topic_skip_date (topicId, skip, date DESC)` ALREADY EXISTS — the
--     topicId path is covered, so this migration does NOT recreate it.
--   * The slaveTopicId path has NO equivalent: its indexes are
--     `(slaveTopicId, emotion, level)` and `(slaveTopicId, eventClusterId, date)`,
--     neither of which lets the date range use the index after the slaveTopicId
--     equality. High-volume slave-matched projects (e.g. 广汽本田) therefore
--     scan a large row set per report — the timeout this migration targets.
--
--   => This migration adds only the missing slaveTopicId counterpart,
--      mirroring the existing index (date DESC) for naming/behaviour symmetry.
--
-- Safety
--   * Idempotent: the guard below adds the index only if it is absent, so the
--     file is safe to re-run.
--   * ALGORITHM=INPLACE, LOCK=NONE builds the index online (MySQL 8.0) without
--     blocking reads/writes. If the server rejects it for this table, drop that
--     clause and run in a low-traffic window, or use pt-online-schema-change /
--     gh-ost for very large tables.
--   * Run against the correct database (the dump names it `superworker`):
--       USE superworker;   -- or connect with that default schema
--
-- Verify after running (should report key=idx_slavetopic_skip_date, type=range):
--   EXPLAIN
--   SELECT COUNT(*) FROM feed_monitor_item f
--   WHERE f.slaveTopicId = <topicId> AND f.skip = 0
--     AND f.`date` >= '2026-05-01 00:00:00' AND f.`date` < '2026-06-01 00:00:00';
-- ---------------------------------------------------------------------------

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'feed_monitor_item'
    AND INDEX_NAME = 'idx_slavetopic_skip_date'
);

SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE `feed_monitor_item` ADD KEY `idx_slavetopic_skip_date` (`slaveTopicId`, `skip`, `date` DESC), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT ''idx_slavetopic_skip_date already exists, skipping'' AS note');

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
