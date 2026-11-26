-- KRATT PRIME Wave 3 WP-03.9: per-intent ACK binding, late-ACK evidence and terminal pair integrity.
-- This migration is additive. Historical outbound rows remain unbound (NULL) and fail closed for ACK acceptance.
-- Apply only through the reviewed migration runner or isolated PostgreSQL integration tests.
BEGIN;

ALTER TABLE kratt_fabric_outbound_events
  ADD COLUMN IF NOT EXISTS ack_policy_revision TEXT NULL;

ALTER TABLE kratt_fabric_outbound_events
  DROP CONSTRAINT IF EXISTS kratt_fabric_outbound_ack_policy_revision_check;
ALTER TABLE kratt_fabric_outbound_events
  ADD CONSTRAINT kratt_fabric_outbound_ack_policy_revision_check
  CHECK (ack_policy_revision IS NULL OR ack_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

COMMENT ON COLUMN kratt_fabric_outbound_events.ack_policy_revision IS
  'Immutable expected receiver policy revision captured when the outbound intent is authorized; NULL means legacy/unbound and cannot be ACK-confirmed.';

CREATE TABLE IF NOT EXISTS kratt_fabric_late_acknowledgements (
  ack_id TEXT PRIMARY KEY CHECK (ack_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  outbox_id TEXT NOT NULL REFERENCES kratt_dispatch_outbox(outbox_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL REFERENCES kratt_dispatch_intents(idempotency_key) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES kratt_fabric_outbound_events(event_id) ON DELETE RESTRICT,
  source_node TEXT NOT NULL CHECK (source_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  receiver_node TEXT NOT NULL CHECK (receiver_node ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  event_digest CHAR(64) NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  delivery_attempt BIGINT NOT NULL CHECK (delivery_attempt > 0),
  result TEXT NOT NULL CHECK (result IN ('ACCEPTED','REJECTED','DUPLICATE','UNKNOWN')),
  policy_revision TEXT NOT NULL CHECK (policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  key_id TEXT NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  content_digest CHAR(64) NOT NULL UNIQUE CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition = 'TASK_CANCELLED_LATE_ACK'),
  ack_json JSONB NOT NULL,
  CONSTRAINT kratt_fabric_late_ack_attempt_unique UNIQUE (outbox_id, delivery_attempt)
);

CREATE INDEX IF NOT EXISTS kratt_fabric_late_ack_received_idx
  ON kratt_fabric_late_acknowledgements(received_at DESC);

CREATE OR REPLACE FUNCTION kratt_guard_fabric_ack_outbox_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding RECORD;
BEGIN
  SELECT
    o.idempotency_key, o.provider, i.task_id,
    e.event_id, e.source_node, e.destination_node, e.source_sequence,
    e.content_digest, e.ack_policy_revision
  INTO binding
  FROM kratt_dispatch_outbox o
  JOIN kratt_dispatch_intents i ON i.idempotency_key = o.idempotency_key
  JOIN kratt_fabric_outbound_events e ON e.idempotency_key = o.idempotency_key
  WHERE o.outbox_id = NEW.outbox_id;

  IF NOT FOUND OR binding.provider <> 'fabric'
     OR binding.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR binding.event_id IS DISTINCT FROM NEW.event_id
     OR binding.source_node IS DISTINCT FROM NEW.source_node
     OR binding.destination_node IS DISTINCT FROM NEW.receiver_node
     OR binding.source_sequence IS DISTINCT FROM NEW.source_sequence
     OR binding.content_digest IS DISTINCT FROM NEW.event_digest
     OR binding.ack_policy_revision IS NULL
     OR binding.ack_policy_revision IS DISTINCT FROM NEW.policy_revision THEN
    RAISE EXCEPTION 'KRATT_FABRIC_ACK_OUTBOX_BINDING_MISMATCH';
  END IF;

  IF NEW.ack_json->>'ack_id' IS DISTINCT FROM NEW.ack_id
     OR NEW.ack_json->>'event_id' IS DISTINCT FROM NEW.event_id
     OR NEW.ack_json->>'source_node' IS DISTINCT FROM NEW.source_node
     OR NEW.ack_json->>'receiver_node' IS DISTINCT FROM NEW.receiver_node
     OR NEW.ack_json->>'source_sequence' IS DISTINCT FROM NEW.source_sequence::TEXT
     OR NEW.ack_json->>'event_digest' IS DISTINCT FROM NEW.event_digest
     OR NEW.ack_json->>'delivery_attempt' IS DISTINCT FROM NEW.delivery_attempt::TEXT
     OR NEW.ack_json->>'result' IS DISTINCT FROM NEW.result
     OR NEW.ack_json->>'policy_revision' IS DISTINCT FROM NEW.policy_revision
     OR NEW.ack_json->>'key_id' IS DISTINCT FROM NEW.key_id
     OR NEW.ack_json->>'content_digest' IS DISTINCT FROM NEW.content_digest
     OR NEW.ack_json->>'issued_at' IS DISTINCT FROM to_char(NEW.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'KRATT_FABRIC_ACK_DOCUMENT_BINDING_MISMATCH';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_ack_outbox_binding ON kratt_fabric_receiver_acknowledgements;
CREATE TRIGGER kratt_fabric_receiver_ack_outbox_binding
  BEFORE INSERT ON kratt_fabric_receiver_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_ack_outbox_binding();

DROP TRIGGER IF EXISTS kratt_fabric_late_ack_outbox_binding ON kratt_fabric_late_acknowledgements;
CREATE TRIGGER kratt_fabric_late_ack_outbox_binding
  BEFORE INSERT ON kratt_fabric_late_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_ack_outbox_binding();

CREATE OR REPLACE FUNCTION kratt_reject_fabric_ack_ledger_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_ACK_LEDGER_TRUNCATE_FORBIDDEN';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_receiver_ack_no_truncate ON kratt_fabric_receiver_acknowledgements;
CREATE TRIGGER kratt_fabric_receiver_ack_no_truncate
  BEFORE TRUNCATE ON kratt_fabric_receiver_acknowledgements
  FOR EACH STATEMENT EXECUTE FUNCTION kratt_reject_fabric_ack_ledger_truncate();

DROP TRIGGER IF EXISTS kratt_fabric_late_ack_no_truncate ON kratt_fabric_late_acknowledgements;
CREATE TRIGGER kratt_fabric_late_ack_no_truncate
  BEFORE TRUNCATE ON kratt_fabric_late_acknowledgements
  FOR EACH STATEMENT EXECUTE FUNCTION kratt_reject_fabric_ack_ledger_truncate();

CREATE OR REPLACE FUNCTION kratt_reject_fabric_late_ack_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_LATE_ACK_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_fabric_late_ack_immutable ON kratt_fabric_late_acknowledgements;
CREATE TRIGGER kratt_fabric_late_ack_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_late_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_late_ack_mutation();

-- Intent and outbox terminal states are a single logical result. Deferred checks allow
-- the two rows to be changed in either order inside one PostgreSQL transaction.
CREATE OR REPLACE FUNCTION kratt_guard_dispatch_intent_outbox_terminal_pair()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  key_value TEXT;
  intent_state TEXT;
  outbox_state TEXT;
BEGIN
  key_value := NEW.idempotency_key;
  SELECT i.status, o.status
    INTO intent_state, outbox_state
  FROM kratt_dispatch_intents i
  JOIN kratt_dispatch_outbox o ON o.idempotency_key = i.idempotency_key
  WHERE i.idempotency_key = key_value;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KRATT_DISPATCH_INTENT_OUTBOX_PAIR_MISSING';
  END IF;

  IF (intent_state IN ('COMPLETED','FAILED') AND outbox_state <> 'DONE')
     OR (intent_state = 'CANCELLED' AND outbox_state <> 'CANCELLED')
     OR (intent_state = 'INTENT_COMMITTED' AND outbox_state IN ('DONE','CANCELLED')) THEN
    RAISE EXCEPTION 'KRATT_DISPATCH_INTENT_OUTBOX_TERMINAL_MISMATCH';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kratt_dispatch_intent_terminal_pair_guard ON kratt_dispatch_intents;
CREATE CONSTRAINT TRIGGER kratt_dispatch_intent_terminal_pair_guard
  AFTER INSERT OR UPDATE ON kratt_dispatch_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_dispatch_intent_outbox_terminal_pair();

DROP TRIGGER IF EXISTS kratt_dispatch_outbox_terminal_pair_guard ON kratt_dispatch_outbox;
CREATE CONSTRAINT TRIGGER kratt_dispatch_outbox_terminal_pair_guard
  AFTER INSERT OR UPDATE ON kratt_dispatch_outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_dispatch_intent_outbox_terminal_pair();

COMMIT;
