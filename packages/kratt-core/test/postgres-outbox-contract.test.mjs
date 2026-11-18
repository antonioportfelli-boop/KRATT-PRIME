import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const migration=readFileSync(join(root,"migrations/0001_postgres_outbox.sql"),"utf8");
const store=readFileSync(join(root,"src/postgres-outbox-store.mjs"),"utf8");
const worker=readFileSync(join(root,"src/outbox-worker.mjs"),"utf8");
test("PostgreSQL schema uniquely consumes approval nonces and dispatch idempotency keys",()=>{
 assert.match(migration,/PRIMARY KEY\(key_id,nonce\)/i);
 assert.match(migration,/idempotency_key TEXT PRIMARY KEY/i);
 assert.match(migration,/idempotency_key TEXT NOT NULL UNIQUE/i);
});
test("outbox supports lease recovery, bounded retries and dead letters",()=>{
 assert.match(migration,/'PENDING','LEASED','DONE','DEAD'/);
 assert.match(migration,/lease_until TIMESTAMPTZ/);
 assert.match(store,/FOR UPDATE SKIP LOCKED/);
 assert.ok(store.includes("lease_until<=$1"));
 assert.match(store,/maxAttempts/);
});
test("nonce, cancellation, intent, outbox and audit reservation share one transaction",()=>{
 const start=store.indexOf("async function reserveAuthorizedIntent"),end=store.indexOf("async function claimOutbox",start),method=store.slice(start,end);
 for(const token of ["kratt_approval_nonces","kratt_cancelled_tasks","kratt_dispatch_intents","kratt_dispatch_outbox","appendAudit"])assert.ok(method.includes(token),token);
 assert.match(method,/return await tx\(pool/);
});
test("worker requires an explicit adapter and forwards the stable idempotency key",()=>{
 assert.match(worker,/Object\.hasOwn\(adapters,item\.provider\)/);
 assert.match(worker,/idempotencyKey:item\.idempotency_key/);
 assert.match(worker,/PROVIDER_ADAPTER_UNAVAILABLE/);
});


test("PostgreSQL migration makes audit events append-only",()=>{
 assert.match(migration,/CREATE TRIGGER kratt_audit_no_update/i);
 assert.match(migration,/CREATE TRIGGER kratt_audit_no_delete/i);
 assert.match(migration,/KRATT_AUDIT_APPEND_ONLY/);
});
