-- KRATT PRIME Wave 3: trusted 3XT-FABRIC/1 inbound idempotency and source ordering.
-- Apply only through the reviewed migration runner. No application startup DDL.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_fabric_event_inbox (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_node TEXT NOT NULL CHECK (source_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  destination_node TEXT NOT NULL CHECK (destination_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  parent_event_id TEXT NULL,
  content_digest CHAR(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  event_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT kratt_fabric_event_source_sequence_unique UNIQUE (source_node, source_sequence),
  CONSTRAINT kratt_fabric_event_ttl_valid CHECK (expires_at > issued_at),
  CONSTRAINT kratt_fabric_event_parent_fk FOREIGN KEY (parent_event_id)
    REFERENCES kratt_fabric_event_inbox(event_id) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS kratt_fabric_event_expiry_idx
  ON kratt_fabric_event_inbox(expires_at);
CREATE INDEX IF NOT EXISTS kratt_fabric_event_parent_idx
  ON kratt_fabric_event_inbox(parent_event_id);

CREATE TABLE IF NOT EXISTS kratt_fabric_source_heads (
  source_node TEXT PRIMARY KEY CHECK (source_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_event_id TEXT NULL REFERENCES kratt_fabric_event_inbox(event_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT kratt_fabric_source_head_shape CHECK (
    (last_sequence = 0 AND last_event_id IS NULL) OR
    (last_sequence > 0 AND last_event_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION kratt_reject_fabric_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_EVENT_INBOX_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_event_inbox_immutable ON kratt_fabric_event_inbox;
CREATE TRIGGER kratt_fabric_event_inbox_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_event_inbox
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_event_mutation();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_source_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_node IS DISTINCT FROM OLD.source_node
     OR NEW.last_sequence <= OLD.last_sequence
     OR NEW.last_event_id IS NULL THEN
    RAISE EXCEPTION 'KRATT_FABRIC_SOURCE_HEAD_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_source_head_guard ON kratt_fabric_source_heads;
CREATE TRIGGER kratt_fabric_source_head_guard
  BEFORE UPDATE ON kratt_fabric_source_heads
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_source_head();

COMMIT;
