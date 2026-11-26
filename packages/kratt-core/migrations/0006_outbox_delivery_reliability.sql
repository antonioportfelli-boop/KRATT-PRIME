-- KRATT PRIME Wave 3 WP-03.6: fenced delivery, cancellation race control and dead-letter reconciliation.
-- Reviewed migration only. This is storage/state machinery, not a live sender.
BEGIN;

ALTER TABLE kratt_dispatch_outbox
  ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS delivery_lease_token TEXT NULL,
  ADD COLUMN IF NOT EXISTS manual_reconciliation_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE kratt_dispatch_outbox
  DROP CONSTRAINT IF EXISTS kratt_dispatch_outbox_status_check;
ALTER TABLE kratt_dispatch_outbox
  ADD CONSTRAINT kratt_dispatch_outbox_status_check
  CHECK (status IN ('PENDING','LEASED','DONE','DEAD','CANCELLED','RECONCILE'));

ALTER TABLE kratt_dispatch_outbox
  DROP CONSTRAINT IF EXISTS kratt_dispatch_outbox_delivery_marker_check;
ALTER TABLE kratt_dispatch_outbox
  ADD CONSTRAINT kratt_dispatch_outbox_delivery_marker_check
  CHECK (
    (delivery_started_at IS NULL AND delivery_lease_token IS NULL) OR
    (delivery_started_at IS NOT NULL AND delivery_lease_token IS NOT NULL)
  );

ALTER TABLE kratt_dispatch_outbox
  DROP CONSTRAINT IF EXISTS kratt_dispatch_outbox_reconciliation_count_check;
ALTER TABLE kratt_dispatch_outbox
  ADD CONSTRAINT kratt_dispatch_outbox_reconciliation_count_check
  CHECK (manual_reconciliation_count BETWEEN 0 AND 16);

ALTER TABLE kratt_dispatch_intents
  DROP CONSTRAINT IF EXISTS kratt_dispatch_intents_status_check;
ALTER TABLE kratt_dispatch_intents
  ADD CONSTRAINT kratt_dispatch_intents_status_check
  CHECK (status IN ('INTENT_COMMITTED','COMPLETED','FAILED','CANCELLED'));

CREATE TABLE IF NOT EXISTS kratt_dispatch_outbox_reconciliations (
  reconciliation_id TEXT PRIMARY KEY CHECK (reconciliation_id ~ '^reconcile:[a-f0-9]{64}$'),
  outbox_id TEXT NOT NULL REFERENCES kratt_dispatch_outbox(outbox_id),
  idempotency_key TEXT NOT NULL REFERENCES kratt_dispatch_intents(idempotency_key),
  task_id TEXT NOT NULL CHECK (task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  decision TEXT NOT NULL CHECK (decision IN ('SAFE_TO_RETRY','CONFIRMED_DELIVERED','CANCELLED')),
  evidence_digest CHAR(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 512),
  actor_id TEXT NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (outbox_id, evidence_digest)
);

CREATE INDEX IF NOT EXISTS kratt_dispatch_outbox_task_status_idx
  ON kratt_dispatch_intents(task_id, status);
CREATE INDEX IF NOT EXISTS kratt_dispatch_outbox_reconcile_idx
  ON kratt_dispatch_outbox(status, updated_at)
  WHERE status IN ('DEAD','RECONCILE');

CREATE OR REPLACE FUNCTION kratt_reject_outbox_reconciliation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_OUTBOX_RECONCILIATION_APPEND_ONLY';
END;
$$;
DROP TRIGGER IF EXISTS kratt_outbox_reconciliation_immutable ON kratt_dispatch_outbox_reconciliations;
CREATE TRIGGER kratt_outbox_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON kratt_dispatch_outbox_reconciliations
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_outbox_reconciliation_mutation();

CREATE OR REPLACE FUNCTION kratt_reject_cancelled_task_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_CANCELLED_TASK_APPEND_ONLY';
END;
$$;
DROP TRIGGER IF EXISTS kratt_cancelled_task_immutable ON kratt_cancelled_tasks;
CREATE TRIGGER kratt_cancelled_task_immutable
  BEFORE UPDATE OR DELETE ON kratt_cancelled_tasks
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_cancelled_task_mutation();

COMMIT;
