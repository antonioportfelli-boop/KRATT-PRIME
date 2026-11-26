-- KRATT PRIME Wave 3 WP-03.7: authenticated receiver ACK persistence and reconciliation.
-- Reviewed, idempotent DDL only. No delivery worker is registered or activated.
BEGIN;

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
  content_digest CHAR(64) NOT NULL UNIQUE CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ack_json JSONB NOT NULL,
  UNIQUE (outbox_id, delivery_attempt),
  CONSTRAINT kratt_fabric_ack_receiver_not_source CHECK (receiver_node <> source_node)
);

CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_ack_event_idx
  ON kratt_fabric_receiver_acknowledgements(event_id, received_at DESC);
CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_ack_outbox_idx
  ON kratt_fabric_receiver_acknowledgements(outbox_id, result, received_at DESC);

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
