-- KRATT PRIME Wave 3 WP-03.8: durable receiver outcomes and per-attempt ACK replay.
-- This migration is applied only by the reviewed CI/test migration path; never at application startup.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_fabric_receiver_receipts (
  event_id TEXT PRIMARY KEY REFERENCES kratt_fabric_event_inbox(event_id) ON DELETE RESTRICT,
  source_node TEXT NOT NULL CHECK (source_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  destination_node TEXT NOT NULL CHECK (destination_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  content_digest CHAR(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  key_id TEXT NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  policy_revision TEXT NULL CHECK (policy_revision IS NULL OR policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED')),
  result_json JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT kratt_fabric_receiver_receipt_source_sequence_unique UNIQUE (source_node, source_sequence)
);

CREATE INDEX IF NOT EXISTS kratt_fabric_receiver_receipts_processed_idx
  ON kratt_fabric_receiver_receipts(processed_at DESC);

CREATE TABLE IF NOT EXISTS kratt_fabric_inbound_acknowledgements (
  event_id TEXT NOT NULL REFERENCES kratt_fabric_receiver_receipts(event_id) ON DELETE RESTRICT,
  delivery_attempt BIGINT NOT NULL CHECK (delivery_attempt > 0),
  ack_id TEXT NOT NULL UNIQUE CHECK (ack_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  content_digest CHAR(64) NOT NULL UNIQUE CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  ack_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, delivery_attempt),
  CONSTRAINT kratt_fabric_inbound_ack_protocol_check CHECK (ack_json->>'protocol' IS NOT DISTINCT FROM '3XT-FABRIC-ACK/1'),
  CONSTRAINT kratt_fabric_inbound_ack_event_binding_check CHECK (
    ack_json->>'event_id' IS NOT DISTINCT FROM event_id AND
    ack_json->>'ack_id' IS NOT DISTINCT FROM ack_id AND
    ack_json->>'delivery_attempt' IS NOT DISTINCT FROM delivery_attempt::text AND
    ack_json->>'content_digest' IS NOT DISTINCT FROM content_digest AND
    ack_json->>'policy_revision' IS NOT NULL AND
    ack_json->>'policy_revision' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}
  )
);

CREATE INDEX IF NOT EXISTS kratt_fabric_inbound_ack_created_idx
  ON kratt_fabric_inbound_acknowledgements(created_at DESC);

CREATE OR REPLACE FUNCTION kratt_reject_fabric_receiver_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_RECEIVER_RECEIPT_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_receipt_immutable ON kratt_fabric_receiver_receipts;
CREATE TRIGGER kratt_fabric_receiver_receipt_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_receiver_receipts
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_receiver_receipt_mutation();

CREATE OR REPLACE FUNCTION kratt_reject_fabric_inbound_ack_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_INBOUND_ACK_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_inbound_ack_immutable ON kratt_fabric_inbound_acknowledgements;
CREATE TRIGGER kratt_fabric_inbound_ack_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_inbound_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_inbound_ack_mutation();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_receiver_receipt_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inbox_row kratt_fabric_event_inbox%ROWTYPE;
BEGIN
  SELECT * INTO inbox_row FROM kratt_fabric_event_inbox WHERE event_id = NEW.event_id;
  IF NOT FOUND OR inbox_row.source_node <> NEW.source_node OR
     inbox_row.destination_node <> NEW.destination_node OR
     inbox_row.source_sequence <> NEW.source_sequence OR
     inbox_row.content_digest <> NEW.content_digest OR
     inbox_row.event_json->>'event_type' <> NEW.event_type OR
     inbox_row.event_json->>'source_revision' <> NEW.source_revision OR
     inbox_row.event_json->>'key_id' <> NEW.key_id THEN
    RAISE EXCEPTION 'KRATT_FABRIC_RECEIVER_RECEIPT_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_receipt_identity_guard ON kratt_fabric_receiver_receipts;
CREATE TRIGGER kratt_fabric_receiver_receipt_identity_guard
  BEFORE INSERT ON kratt_fabric_receiver_receipts
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_receiver_receipt_identity();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_inbound_ack_binding()
RETURNS trigger LANGUAGE plpgsql AS $wp03_8$
DECLARE receipt_row kratt_fabric_receiver_receipts%ROWTYPE;
BEGIN
  SELECT * INTO receipt_row FROM kratt_fabric_receiver_receipts WHERE event_id = NEW.event_id;
  IF NOT FOUND OR NEW.ack_json->>'event_id' IS DISTINCT FROM NEW.event_id OR
     NEW.ack_json->>'source_node' IS DISTINCT FROM receipt_row.source_node OR
     NEW.ack_json->>'receiver_node' IS DISTINCT FROM receipt_row.destination_node OR
     NEW.ack_json->>'source_sequence' IS DISTINCT FROM receipt_row.source_sequence::text OR
     NEW.ack_json->>'event_digest' IS DISTINCT FROM receipt_row.content_digest OR
     NEW.ack_json->>'policy_revision' IS DISTINCT FROM receipt_row.policy_revision OR
     NEW.ack_json->>'result' IS NULL OR
     NEW.ack_json->>'result' NOT IN ('ACCEPTED','DUPLICATE') THEN
    RAISE EXCEPTION 'KRATT_FABRIC_INBOUND_ACK_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$wp03_8$;

DROP TRIGGER IF EXISTS kratt_fabric_inbound_ack_binding_guard ON kratt_fabric_inbound_acknowledgements;
CREATE TRIGGER kratt_fabric_inbound_ack_binding_guard
  BEFORE INSERT ON kratt_fabric_inbound_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_inbound_ack_binding();

COMMIT; AND
    ack_json->>'result' IS NOT NULL AND
    ack_json->>'result' IN ('ACCEPTED','DUPLICATE')
  )
);

CREATE INDEX IF NOT EXISTS kratt_fabric_inbound_ack_created_idx
  ON kratt_fabric_inbound_acknowledgements(created_at DESC);

CREATE OR REPLACE FUNCTION kratt_reject_fabric_receiver_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_RECEIVER_RECEIPT_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_receipt_immutable ON kratt_fabric_receiver_receipts;
CREATE TRIGGER kratt_fabric_receiver_receipt_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_receiver_receipts
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_receiver_receipt_mutation();

CREATE OR REPLACE FUNCTION kratt_reject_fabric_inbound_ack_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_INBOUND_ACK_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_inbound_ack_immutable ON kratt_fabric_inbound_acknowledgements;
CREATE TRIGGER kratt_fabric_inbound_ack_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_inbound_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_inbound_ack_mutation();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_receiver_receipt_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inbox_row kratt_fabric_event_inbox%ROWTYPE;
BEGIN
  SELECT * INTO inbox_row FROM kratt_fabric_event_inbox WHERE event_id = NEW.event_id;
  IF NOT FOUND OR inbox_row.source_node <> NEW.source_node OR
     inbox_row.destination_node <> NEW.destination_node OR
     inbox_row.source_sequence <> NEW.source_sequence OR
     inbox_row.content_digest <> NEW.content_digest OR
     inbox_row.event_json->>'event_type' <> NEW.event_type OR
     inbox_row.event_json->>'source_revision' <> NEW.source_revision OR
     inbox_row.event_json->>'key_id' <> NEW.key_id THEN
    RAISE EXCEPTION 'KRATT_FABRIC_RECEIVER_RECEIPT_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_receipt_identity_guard ON kratt_fabric_receiver_receipts;
CREATE TRIGGER kratt_fabric_receiver_receipt_identity_guard
  BEFORE INSERT ON kratt_fabric_receiver_receipts
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_receiver_receipt_identity();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_inbound_ack_binding()
RETURNS trigger LANGUAGE plpgsql AS $wp03_8$
DECLARE receipt_row kratt_fabric_receiver_receipts%ROWTYPE;
BEGIN
  SELECT * INTO receipt_row FROM kratt_fabric_receiver_receipts WHERE event_id = NEW.event_id;
  IF NOT FOUND OR NEW.ack_json->>'source_node' <> receipt_row.source_node OR
     NEW.ack_json->>'receiver_node' <> receipt_row.destination_node OR
     NEW.ack_json->>'source_sequence' <> receipt_row.source_sequence::text OR
     NEW.ack_json->>'event_digest' <> receipt_row.content_digest OR
     NEW.ack_json->>'policy_revision' IS DISTINCT FROM receipt_row.policy_revision OR
     NEW.ack_json->>'result' NOT IN ('ACCEPTED','DUPLICATE') THEN
    RAISE EXCEPTION 'KRATT_FABRIC_INBOUND_ACK_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$wp03_8$;

DROP TRIGGER IF EXISTS kratt_fabric_inbound_ack_binding_guard ON kratt_fabric_inbound_acknowledgements;
CREATE TRIGGER kratt_fabric_inbound_ack_binding_guard
  BEFORE INSERT ON kratt_fabric_inbound_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_inbound_ack_binding();

COMMIT;