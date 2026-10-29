-- Apply to the same database as history_messages before deploying either service.
CREATE TABLE IF NOT EXISTS lobster_chat_cancellations (
  history_id BIGINT NOT NULL PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending',
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64) NULL,
  settled_at DATETIME(3) NULL,
  KEY cancellation_dispatch (state, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
