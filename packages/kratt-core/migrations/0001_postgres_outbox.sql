-- KRATT PRIME Wave 4 PostgreSQL shared command/outbox schema. Apply via reviewed migration runner.
BEGIN;
CREATE TABLE IF NOT EXISTS kratt_approval_nonces(key_id TEXT NOT NULL,nonce TEXT NOT NULL,approval_id TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(key_id,nonce));
CREATE TABLE IF NOT EXISTS kratt_dispatch_intents(idempotency_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,correlation_id TEXT NOT NULL,actor_id TEXT NOT NULL,provider TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('INTENT_COMMITTED','COMPLETED','FAILED')),created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS kratt_dispatch_intents_task_idx ON kratt_dispatch_intents(task_id,created_at DESC);
-- Upgrade compatibility: legacy rows use task_id as their correlation fallback.
ALTER TABLE kratt_dispatch_intents ADD COLUMN IF NOT EXISTS correlation_id TEXT;
UPDATE kratt_dispatch_intents SET correlation_id=task_id WHERE correlation_id IS NULL;
ALTER TABLE kratt_dispatch_intents ALTER COLUMN correlation_id SET NOT NULL;
ALTER TABLE kratt_dispatch_outbox ADD COLUMN IF NOT EXISTS correlation_id TEXT;
UPDATE kratt_dispatch_outbox o SET correlation_id=i.correlation_id FROM kratt_dispatch_intents i WHERE o.idempotency_key=i.idempotency_key AND o.correlation_id IS NULL;
ALTER TABLE kratt_dispatch_outbox ALTER COLUMN correlation_id SET NOT NULL;
CREATE TABLE IF NOT EXISTS kratt_dispatch_outbox(outbox_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE REFERENCES kratt_dispatch_intents(idempotency_key),correlation_id TEXT NOT NULL,provider TEXT NOT NULL,payload JSONB NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','LEASED','DONE','DEAD')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),available_at TIMESTAMPTZ NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until TIMESTAMPTZ,last_error_code TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),CHECK((status='LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR status<>'LEASED'));
CREATE INDEX IF NOT EXISTS kratt_outbox_ready_idx ON kratt_dispatch_outbox(status,available_at,outbox_id);
CREATE INDEX IF NOT EXISTS kratt_outbox_lease_idx ON kratt_dispatch_outbox(status,lease_until);
CREATE TABLE IF NOT EXISTS kratt_cancelled_tasks(task_id TEXT PRIMARY KEY,cancelled_at TIMESTAMPTZ NOT NULL,actor_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kratt_audit_head(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),sequence BIGINT NOT NULL DEFAULT 0,hash CHAR(64) NOT NULL);
INSERT INTO kratt_audit_head(singleton,sequence,hash) VALUES(TRUE,0,repeat('0',64)) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS kratt_audit_events(sequence BIGINT PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,record_json JSONB NOT NULL,previous_hash CHAR(64) NOT NULL,hash CHAR(64) NOT NULL UNIQUE);
COMMIT;
