-- KRATT PRIME Wave 3 WP-03.5: persisted Fabric trust registry.
-- Public keys only. Private signing material remains in an external key provider/HSM.
-- Apply through the reviewed migration runner; never at application startup.
BEGIN;

CREATE TABLE IF NOT EXISTS kratt_fabric_trust_audit_head (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_hash CHAR(64) NOT NULL CHECK (last_hash ~ '^[0-9a-f]{64}$')
);
INSERT INTO kratt_fabric_trust_audit_head(singleton,last_sequence,last_hash)
VALUES(TRUE,0,repeat('0',64)) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS kratt_fabric_trust_audit (
  sequence BIGINT PRIMARY KEY CHECK(sequence > 0),
  action TEXT NOT NULL CHECK(action ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  actor_id TEXT NOT NULL CHECK(actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  node_id TEXT NOT NULL,
  key_id TEXT NULL,
  policy_version INTEGER NULL,
  record_json TEXT NOT NULL,
  previous_hash CHAR(64) NOT NULL CHECK(previous_hash ~ '^[0-9a-f]{64}$'),
  record_hash CHAR(64) NOT NULL CHECK(record_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS kratt_fabric_trusted_nodes (
  node_id TEXT PRIMARY KEY CHECK(node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  repository_full_name TEXT NOT NULL UNIQUE CHECK(repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  repository_revision CHAR(40) NOT NULL CHECK(repository_revision ~ '^[0-9a-f]{40}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS kratt_fabric_trusted_keys (
  node_id TEXT NOT NULL REFERENCES kratt_fabric_trusted_nodes(node_id),
  key_id TEXT NOT NULL CHECK(key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  public_key_pem TEXT NOT NULL CHECK(length(public_key_pem) BETWEEN 64 AND 8192),
  public_key_fingerprint CHAR(64) NOT NULL CHECK(public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVE','VERIFY_ONLY','REVOKED')),
  valid_from TIMESTAMPTZ NOT NULL,
  sign_until TIMESTAMPTZ NULL,
  retired_at TIMESTAMPTZ NULL,
  verify_until TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_by TEXT NOT NULL CHECK(created_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(node_id,key_id),
  CONSTRAINT kratt_fabric_key_sign_window CHECK(sign_until IS NULL OR sign_until > valid_from),
  CONSTRAINT kratt_fabric_key_verify_window CHECK(verify_until IS NULL OR retired_at IS NULL OR verify_until >= retired_at),
  CONSTRAINT kratt_fabric_key_state_shape CHECK(
    (status <> 'VERIFY_ONLY' OR retired_at IS NOT NULL) AND
    (status <> 'REVOKED' OR revoked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS kratt_fabric_trust_policies (
  node_id TEXT NOT NULL REFERENCES kratt_fabric_trusted_nodes(node_id),
  destination_node TEXT NOT NULL REFERENCES kratt_fabric_trusted_nodes(node_id),
  event_type TEXT NOT NULL CHECK(event_type ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  allowed_scope TEXT[] NOT NULL CHECK(cardinality(allowed_scope) BETWEEN 1 AND 64),
  max_ttl_ms INTEGER NOT NULL CHECK(max_ttl_ms BETWEEN 1000 AND 86400000),
  approval_provider TEXT NOT NULL CHECK(approval_provider ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  approval_authority TEXT NOT NULL CHECK(approval_authority ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  key_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
  created_by TEXT NOT NULL CHECK(created_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ NULL,
  PRIMARY KEY(node_id,destination_node,event_type,policy_version),
  CONSTRAINT kratt_fabric_policy_key_fk FOREIGN KEY(node_id,key_id)
    REFERENCES kratt_fabric_trusted_keys(node_id,key_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kratt_fabric_trust_policy_active_unique
  ON kratt_fabric_trust_policies(node_id,destination_node,event_type) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS kratt_fabric_trust_key_lookup_idx
  ON kratt_fabric_trusted_keys(node_id,key_id,status);
CREATE INDEX IF NOT EXISTS kratt_fabric_trust_policy_lookup_idx
  ON kratt_fabric_trust_policies(node_id,destination_node,event_type,status);

CREATE OR REPLACE FUNCTION kratt_guard_fabric_trusted_node()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'KRATT_FABRIC_TRUST_NODE_APPEND_ONLY'; END IF;
  IF NEW.node_id IS DISTINCT FROM OLD.node_id
     OR NEW.repository_full_name IS DISTINCT FROM OLD.repository_full_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_NODE_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kratt_fabric_trust_node_guard ON kratt_fabric_trusted_nodes;
CREATE TRIGGER kratt_fabric_trust_node_guard
  BEFORE UPDATE OR DELETE ON kratt_fabric_trusted_nodes
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_trusted_node();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_trusted_key()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_APPEND_ONLY'; END IF;
  IF NEW.node_id IS DISTINCT FROM OLD.node_id
     OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.public_key_pem IS DISTINCT FROM OLD.public_key_pem
     OR NEW.public_key_fingerprint IS DISTINCT FROM OLD.public_key_fingerprint
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.sign_until IS DISTINCT FROM OLD.sign_until
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT (
    (OLD.status='PENDING' AND NEW.status IN ('ACTIVE','REVOKED')) OR
    (OLD.status='ACTIVE' AND NEW.status IN ('VERIFY_ONLY','REVOKED')) OR
    (OLD.status='VERIFY_ONLY' AND NEW.status='REVOKED')
  ) THEN RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_TRANSITION_INVALID'; END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_RETIREMENT_IMMUTABLE';
  END IF;
  IF OLD.status <> 'VERIFY_ONLY' AND NEW.verify_until IS DISTINCT FROM OLD.verify_until
     AND NEW.status <> 'VERIFY_ONLY' THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_VERIFY_WINDOW_INVALID';
  END IF;
  IF NEW.status='VERIFY_ONLY' AND (NEW.retired_at IS NULL OR NEW.verify_until IS NULL) THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_VERIFY_WINDOW_REQUIRED';
  END IF;
  IF OLD.status='REVOKED' OR (OLD.status='VERIFY_ONLY' AND NEW.status <> 'REVOKED') THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_KEY_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kratt_fabric_trust_key_guard ON kratt_fabric_trusted_keys;
CREATE TRIGGER kratt_fabric_trust_key_guard
  BEFORE UPDATE OR DELETE ON kratt_fabric_trusted_keys
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_trusted_key();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_trust_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'KRATT_FABRIC_TRUST_POLICY_APPEND_ONLY'; END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'DISABLED'
     OR (to_jsonb(NEW)-'status'-'disabled_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'disabled_at')
     OR NEW.disabled_at IS NULL THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_POLICY_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kratt_fabric_trust_policy_guard ON kratt_fabric_trust_policies;
CREATE TRIGGER kratt_fabric_trust_policy_guard
  BEFORE UPDATE OR DELETE ON kratt_fabric_trust_policies
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_trust_policy();

CREATE OR REPLACE FUNCTION kratt_reject_fabric_trust_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KRATT_FABRIC_TRUST_AUDIT_APPEND_ONLY';
END;
$$;
DROP TRIGGER IF EXISTS kratt_fabric_trust_audit_immutable ON kratt_fabric_trust_audit;
CREATE TRIGGER kratt_fabric_trust_audit_immutable
  BEFORE UPDATE OR DELETE ON kratt_fabric_trust_audit
  FOR EACH ROW EXECUTE FUNCTION kratt_reject_fabric_trust_audit_mutation();

CREATE OR REPLACE FUNCTION kratt_guard_fabric_trust_audit_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.last_sequence <> OLD.last_sequence+1
     OR NEW.last_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'KRATT_FABRIC_TRUST_AUDIT_HEAD_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kratt_fabric_trust_audit_head_guard ON kratt_fabric_trust_audit_head;
CREATE TRIGGER kratt_fabric_trust_audit_head_guard
  BEFORE UPDATE OR DELETE ON kratt_fabric_trust_audit_head
  FOR EACH ROW EXECUTE FUNCTION kratt_guard_fabric_trust_audit_head();

COMMIT;
