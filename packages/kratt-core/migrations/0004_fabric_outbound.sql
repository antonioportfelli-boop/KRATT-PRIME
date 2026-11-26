-- KRATT PRIME Wave 3: outbound Fabric sequence reservations and immutable wire events.
-- Reviewed migration only. Never applied automatically at service startup.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_fabric_outbound_heads (
  source_node TEXT PRIMARY KEY CHECK (source_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS kratt_fabric_outbound_sequences (
  source_node TEXT NOT NULL REFERENCES kratt_fabric_outbound_heads(source_node),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^kratt:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}:[a-f0-9]{64}$'),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_node, idempotency_key),
  CONSTRAINT kratt_fabric_outbound_source_sequence_unique UNIQUE (source_node, source_sequence)
);

CREATE TABLE IF NOT EXISTS kratt_fabric_outbound_events (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES kratt_dispatch_intents(idempotency_key),
  source_node TEXT NOT NULL,
  destination_node TEXT NOT NULL,
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  key_id TEXT NOT NULL,
  content_digest CHAR(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  event_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT kratt_fabric_outbound_event_sequence_unique UNIQUE (source_node, source_sequence),
  CONSTRAINT kratt_fabric_outbound_event_ttl CHECK (expires_at > issued_at),
  CONSTRAINT kratt_fabric_outbound_sequence_binding
    FOREIGN KEY (source_node, idempotency_key)
    REFERENCES kratt_fabric_outbound_sequences(source_node, idempotency_key)
);

CREATE INDEX IF NOT EXISTS kratt_fabric_outbound_destination_created_idx
  ON kratt_fabric_outbound_events(destination_node, created_at DESC);

CREATE OR REPLACE FUNCTION kratt_reject_fabric_outbound_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_OUTBOUND_EVENTS_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_outbound_sequences_immutable ON kratt_fabric_outbound_sequences;
CREATE TRIGGER kratt_fabric_outbound_sequences_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_outbound_sequences
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_outbound_mutation();

DROP TRIGGER IF EXISTS kratt_fabric_outbound_events_immutable ON kratt_fabric_outbound_events;
CREATE TRIGGER kratt_fabric_outbound_events_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_outbound_events
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_outbound_mutation();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_outbound_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_node IS DISTINCT FROM OLD.source_node
     OR NEW.last_sequence <= OLD.last_sequence THEN
    RAISE EXCEPTION 'KRATT_FABRIC_OUTBOUND_HEAD_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_outbound_head_guard ON kratt_fabric_outbound_heads;
CREATE TRIGGER kratt_fabric_outbound_head_guard
  BEFORE UPDATE ON kratt_fabric_outbound_heads
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_outbound_head();

COMMIT;
