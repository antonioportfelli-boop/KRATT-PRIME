-- KRATT PRIME: durable append-only semantic memory with a verifiable hash chain.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_semantic_memory_head (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  hash CHAR(64) NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$')
);
INSERT INTO kratt_semantic_memory_head(singleton, sequence, hash)
VALUES (TRUE, 0, repeat('0', 64))
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS kratt_semantic_memory_events (
  sequence BIGINT PRIMARY KEY CHECK (sequence > 0),
  memory_id TEXT NOT NULL UNIQUE,
  record_json JSONB NOT NULL,
  previous_hash CHAR(64) NOT NULL CHECK (previous_hash ~ '^[a-f0-9]{64}$'),
  hash CHAR(64) NOT NULL UNIQUE CHECK (hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS kratt_semantic_memory_kind_sequence_idx
  ON kratt_semantic_memory_events ((record_json->>'kind'), sequence);

CREATE OR REPLACE FUNCTION kratt_reject_semantic_memory_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_SEMANTIC_MEMORY_APPEND_ONLY';
END;
$$;
DROP TRIGGER IF EXISTS kratt_semantic_memory_event_no_update ON kratt_semantic_memory_events;
CREATE TRIGGER kratt_semantic_memory_event_no_update
  BEFORE UPDATE ON kratt_semantic_memory_events
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_semantic_memory_event_mutation();
DROP TRIGGER IF EXISTS kratt_semantic_memory_event_no_delete ON kratt_semantic_memory_events;
CREATE TRIGGER kratt_semantic_memory_event_no_delete
  BEFORE DELETE ON kratt_semantic_memory_events
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_semantic_memory_event_mutation();

-- Restrict the runtime role to append and verify; no DELETE or event UPDATE privilege.
COMMIT;
