-- KRATT PRIME Wave 7: Telegram competitive intelligence inbox and immutable snapshots.
-- Apply with the reviewed migration runner. No Telegram credentials are stored here.
BEGIN;


CREATE TABLE IF NOT EXISTS kratt_telegram_competitive_inbox (
  bot_id TEXT NOT NULL,
  update_id BIGINT NOT NULL CHECK (update_id >= 0),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING','COMPLETED')),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  snapshot_id TEXT,
  result_json JSONB,
  PRIMARY KEY (bot_id, update_id),
  CHECK (
    (status = 'PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND completed_at IS NULL)
    OR
    (status = 'COMPLETED' AND lease_token IS NULL AND lease_until IS NULL AND completed_at IS NOT NULL
      AND snapshot_id IS NOT NULL AND result_json IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS kratt_telegram_competitive_inbox_lease_idx
  ON kratt_telegram_competitive_inbox(status, lease_until)
  WHERE status = 'PROCESSING';

CREATE TABLE IF NOT EXISTS kratt_competitor_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  bot_id TEXT NOT NULL,
  telegram_update_id BIGINT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  snapshot_json JSONB NOT NULL,
  snapshot_digest CHAR(64) NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  previous_snapshot_id TEXT REFERENCES kratt_competitor_snapshots(snapshot_id),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT kratt_competitor_snapshot_inbox_fk
    FOREIGN KEY (bot_id, telegram_update_id)
    REFERENCES kratt_telegram_competitive_inbox(bot_id, update_id),
  CONSTRAINT kratt_competitor_snapshot_update_unique
    UNIQUE (bot_id, telegram_update_id, competitor_id)
);

CREATE INDEX IF NOT EXISTS kratt_competitor_snapshots_latest_idx
  ON kratt_competitor_snapshots(competitor_id, captured_at DESC, snapshot_id DESC);

CREATE TABLE IF NOT EXISTS kratt_competitor_snapshot_head (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  hash CHAR(64) NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$')
);

INSERT INTO kratt_competitor_snapshot_head(singleton, sequence, hash)
VALUES (TRUE, 0, repeat('0', 64))
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS kratt_competitor_snapshot_events (
  sequence BIGINT PRIMARY KEY CHECK (sequence > 0),
  event_id TEXT NOT NULL UNIQUE,
  snapshot_id TEXT NOT NULL REFERENCES kratt_competitor_snapshots(snapshot_id),
  created_at TIMESTAMPTZ NOT NULL,
  record_json JSONB NOT NULL,
  previous_hash CHAR(64) NOT NULL CHECK (previous_hash ~ '^[a-f0-9]{64}$'),
  hash CHAR(64) NOT NULL UNIQUE CHECK (hash ~ '^[a-f0-9]{64}$')
);

CREATE OR REPLACE FUNCTION kratt_reject_competitor_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_COMPETITOR_SNAPSHOT_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_competitor_snapshot_no_update ON kratt_competitor_snapshots;
CREATE TRIGGER kratt_competitor_snapshot_no_update
  BEFORE UPDATE ON kratt_competitor_snapshots
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_competitor_snapshot_mutation();

DROP TRIGGER IF EXISTS kratt_competitor_snapshot_no_delete ON kratt_competitor_snapshots;
CREATE TRIGGER kratt_competitor_snapshot_no_delete
  BEFORE DELETE ON kratt_competitor_snapshots
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_competitor_snapshot_mutation();

DROP TRIGGER IF EXISTS kratt_competitor_snapshot_event_no_update ON kratt_competitor_snapshot_events;
CREATE TRIGGER kratt_competitor_snapshot_event_no_update
  BEFORE UPDATE ON kratt_competitor_snapshot_events
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_competitor_snapshot_mutation();

DROP TRIGGER IF EXISTS kratt_competitor_snapshot_event_no_delete ON kratt_competitor_snapshot_events;
CREATE TRIGGER kratt_competitor_snapshot_event_no_delete
  BEFORE DELETE ON kratt_competitor_snapshot_events
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_competitor_snapshot_mutation();

-- Runtime role: grant SELECT/INSERT on snapshot and event tables only.
-- Inbox table requires SELECT/INSERT/UPDATE/DELETE for lease/retry lifecycle.
-- Snapshot event head requires SELECT/UPDATE. Never grant DELETE/UPDATE on snapshots/events.
COMMIT;
