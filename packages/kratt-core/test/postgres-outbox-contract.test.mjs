import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const migration=readFileSync(join(root,"migrations/0001_postgres_outbox.sql"),"utf8");
const store=readFileSync(join(root,"src/postgres-outbox-store.mjs"),"utf8");
const worker=readFileSync(join(root,"src/outbox-worker.mjs"),"utf8");
const authorizedDispatch=readFileSync(join(root,"src/authorized-dispatch.mjs"),"utf8");
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
test("worker cannot dispatch unless the PostgreSQL delivery-start fence is available and succeeds",()=>{
 assert.match(worker,/typeof store\.beginOutboxDelivery !== "function"/);
 assert.ok(worker.indexOf("store.beginOutboxDelivery")<worker.indexOf("adapter.dispatch"));
 assert.match(worker,/started\?\.duplicate === true/);
 assert.match(worker,/retrySafety: "UNKNOWN"/);
});
test("synchronous authorized dispatch requires a durable delivery-start token before provider dispatch",()=>{
 assert.match(authorizedDispatch,/typeof commandStore\.beginAuthorizedDelivery !== "function"/);
 assert.ok(authorizedDispatch.indexOf("commandStore.beginAuthorizedDelivery")<authorizedDispatch.indexOf("adapter.dispatch"));
 assert.match(authorizedDispatch,/deliveryToken, record: outcome/);
 assert.match(authorizedDispatch,/dispatch\.reconcile_required/);
});

test("worker requires an explicit adapter and forwards the stable idempotency key",()=>{
 assert.match(worker,/Object\.hasOwn\(adapters,\s*item\.provider\)/);
 assert.match(worker,/idempotencyKey:item\.idempotency_key/);
 assert.match(worker,/PROVIDER_ADAPTER_UNAVAILABLE/);
});
