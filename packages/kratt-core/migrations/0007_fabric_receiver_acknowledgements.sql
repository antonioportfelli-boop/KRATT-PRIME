-- KRATT PRIME Wave 3 WP-03.7: authenticated receiver acknowledgement receipt.
-- Sender-side receipt ledger only; no receiver worker, network sender or migration runner is activated.
-- Append-only records are bound to one immutable outbound event and one delivery attempt.
BEGIN;

-- Retry budget counters may reset during manual reconciliation. This independent
-- sequence is the identity of each actual delivery attempt.
ALTER TABLE kratt_dispatch_outbox
  ADD COLUMN IF NOT EXISTS delivery_attempt_sequence BIGINT NOT NULL DEFAULT 0;

UPDATE kratt_dispatch_outbox
SET delivery_attempt_sequence = attempts
WHERE delivery_attempt_sequence = 0 AND attempts > 0;

ALTER TABLE kratt_dispatch_outbox
  DROP CONSTRAINT IF EXISTS kratt_dispatch_outbox_delivery_attempt_sequence_check;
ALTER TABLE kratt_dispatch_outbox
  ADD CONSTRAINT kratt_dispatch_outbox_delivery_attempt_sequence_check
  CHECK (delivery_attempt_sequence >= 0);

CREATE OR REPLACE FUNCTION kratt_guard_delivery_attempt_sequence()
RETURNS trigger LANGUAGE plpgsql AS $kratt$
BEGIN
  IF NEW.delivery_attempt_sequence < OLD.delivery_attempt_sequence
     OR NEW.delivery_attempt_sequence > OLD.delivery_attempt_sequence + 1 THEN
    RAISE EXCEPTION 'KRATT_OUTBOX_DELIVERY_ATTEMPT_SEQUENCE_INVALID';
  END IF;
  RETURN NEW;
END;
$kratt$;

DROP TRIGGER IF EXISTS kratt_delivery_attempt_sequence_guard ON kratt_dispatch_outbox;
CREATE TRIGGER kratt_delivery_attempt_sequence_guard
  BEFORE UPDATE ON kratt_dispatch_outbox
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_delivery_attempt_sequence();

CREATE TABLE IF NOT EXISTS kratt_fabric_receiver_acknowledgements (
  ack_id TEXT PRIMARY KEY CHECK (ack_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  outbox_id TEXT NOT NULL REFERENCES kratt_dispatch_outbox(outbox_id),
  idempotency_key TEXT NOT NULL REFERENCES kratt_dispatch_intents(idempotency_key),
  event_id TEXT NOT NULL REFERENCES kratt_fabric_outbound_events(event_id),
  source_node TEXT NOT NULL CHECK (source_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  receiver_node TEXT NOT NULL CHECK (receiver_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  event_digest CHAR(64) NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  delivery_attempt INTEGER NOT NULL CHECK (delivery_attempt > 0),
  result TEXT NOT NULL CHECK (result IN ('ACCEPTED','REJECTED','DUPLICATE','UNKNOWN')),
  policy_revision TEXT NOT NULL CHECK (policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  key_id TEXT NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  content_digest CHAR(64) NOT NULL UNIQUE CHECK (content_digest ~ '^[a-f0-9]{64}
  issued_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ack_json JSONB NOT NULL,
  CONSTRAINT kratt_fabric_receiver_ack_attempt_unique UNIQUE (outbox_id, delivery_attempt)
);

CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_ack_event_idx
  ON kratt_fabric_receiver_acknowledgements(event_id, source_sequence);
CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_ack_received_idx
  ON kratt_fabric_receiver_acknowledgements(received_at DESC);

CREATE OR REPLACE FUNCTION kratt_reject_fabric_receiver_ack_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_RECEIVER_ACK_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_ack_immutable ON kratt_fabric_receiver_acknowledgements;
CREATE TRIGGER kratt_fabric_receiver_ack_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_receiver_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_receiver_ack_mutation();

COMMIT;
),
  issued_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ack_json JSONB NOT NULL,
  CONSTRAINT kratt_fabric_receiver_ack_attempt_unique UNIQUE (outbox_id, delivery_attempt)
);

CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_ack_event_idx
  ON kratt_fabric_receiver_acknowledgements(event_id, source_sequence);
CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_ack_received_idx
  ON kratt_fabric_receiver_acknowledgements(received_at DESC);

CREATE OR REPLACE FUNCTION kratt_reject_fabric_receiver_ack_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_RECEIVER_ACK_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_ack_immutable ON kratt_fabric_receiver_acknowledgements;
CREATE TRIGGER kratt_fabric_receiver_ack_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_receiver_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_receiver_ack_mutation();

COMMIT;
