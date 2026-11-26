-- KRATT PRIME Wave 2 shared runtime journal and worker leases.
-- Apply only through the reviewed migration runner to an isolated/staging database.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_runtime_journal_head (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  sequence BIGINT NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  hash CHAR(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO kratt_runtime_journal_head(singleton, sequence, hash)
VALUES (TRUE, 0, repeat('0', 64))
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS kratt_runtime_journal_entries (
  sequence BIGINT PRIMARY KEY CHECK (sequence > 0),
  entry_id TEXT NOT NULL UNIQUE CHECK (entry_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  record_key TEXT NOT NULL CHECK (record_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  value JSONB NOT NULL,
  previous_hash CHAR(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  entry_hash CHAR(64) NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS kratt_runtime_journal_record_key_sequence_idx
  ON kratt_runtime_journal_entries(record_key, sequence);

CREATE OR REPLACE FUNCTION kratt_reject_runtime_journal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_RUNTIME_JOURNAL_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_runtime_journal_entries_immutable
  ON kratt_runtime_journal_entries;
CREATE TRIGGER kratt_runtime_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON kratt_runtime_journal_entries
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_runtime_journal_mutation();

CREATE OR REPLACE FUNCTION kratt_guard_runtime_journal_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM TRUE OR
     NEW.sequence < OLD.sequence OR
     NEW.sequence > OLD.sequence + 1 OR
     NEW.hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'KRATT_RUNTIME_JOURNAL_HEAD_TRANSITION_INVALID';
  END IF;
  IF NEW.sequence = OLD.sequence AND NEW.hash IS DISTINCT FROM OLD.hash THEN
    RAISE EXCEPTION 'KRATT_RUNTIME_JOURNAL_HEAD_HASH_MUTATION';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_runtime_journal_head_guard
  ON kratt_runtime_journal_head;
CREATE TRIGGER kratt_runtime_journal_head_guard
  BEFORE UPDATE ON kratt_runtime_journal_head
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_runtime_journal_head();

CREATE TABLE IF NOT EXISTS kratt_worker_lease_reservations (
  reservation_key TEXT PRIMARY KEY
    CHECK (reservation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  task_digest TEXT NOT NULL CHECK (task_digest ~ '^sha256:[0-9a-f]{64}$'),
  fence BIGINT NOT NULL DEFAULT 0 CHECK (fence >= 0),
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'LEASED')),
  owner_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'AVAILABLE' AND owner_id IS NULL AND expires_at IS NULL) OR
    (status = 'LEASED' AND owner_id IS NOT NULL AND
      owner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS kratt_worker_lease_expiry_idx
  ON kratt_worker_lease_reservations(status, expires_at);

CREATE TABLE IF NOT EXISTS kratt_worker_lease_operations (
  operation_id TEXT PRIMARY KEY
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  operation_digest TEXT NOT NULL CHECK (operation_digest ~ '^sha256:[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN ('acquire', 'renew', 'release')),
  reservation_key TEXT NOT NULL
    REFERENCES kratt_worker_lease_reservations(reservation_key),
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS kratt_worker_lease_operations_reservation_idx
  ON kratt_worker_lease_operations(reservation_key, created_at);

CREATE OR REPLACE FUNCTION kratt_guard_worker_lease_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'KRATT_WORKER_LEASE_RESERVATIONS_APPEND_ONLY_IDENTITY';
  END IF;
  IF NEW.reservation_key IS DISTINCT FROM OLD.reservation_key OR
     NEW.task_digest IS DISTINCT FROM OLD.task_digest OR
     NEW.fence < OLD.fence OR NEW.fence > OLD.fence + 1 THEN
    RAISE EXCEPTION 'KRATT_WORKER_LEASE_FENCE_OR_IDENTITY_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kratt_worker_lease_reservation_guard
  ON kratt_worker_lease_reservations;
CREATE TRIGGER kratt_worker_lease_reservation_guard
  BEFORE UPDATE OR DELETE ON kratt_worker_lease_reservations
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_worker_lease_reservation();

CREATE OR REPLACE FUNCTION kratt_reject_worker_lease_operation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_WORKER_LEASE_OPERATIONS_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS kratt_worker_lease_operations_immutable
  ON kratt_worker_lease_operations;
CREATE TRIGGER kratt_worker_lease_operations_immutable
  BEFORE UPDATE OR DELETE ON kratt_worker_lease_operations
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_worker_lease_operation_mutation();

COMMIT;
