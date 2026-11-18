-- KRATT PRIME Wave 8: shared staging Telegram ingress rate limiter.
-- Kept separate so deployments that already applied migration 0002 receive this schema.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_telegram_ingress_rate_limits (
  bucket_hash CHAR(64) PRIMARY KEY CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_start_ms BIGINT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);

CREATE INDEX IF NOT EXISTS kratt_telegram_ingress_rate_limits_window_idx
  ON kratt_telegram_ingress_rate_limits(window_start_ms);

COMMIT;
