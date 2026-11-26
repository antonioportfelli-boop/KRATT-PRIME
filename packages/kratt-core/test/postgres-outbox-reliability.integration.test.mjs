import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPostgresOutboxStore } from "../src/postgres-outbox-store.mjs";
import { createOutboxWorker } from "../src/outbox-worker.mjs";

const connectionString=process.env.KRATT_TEST_DATABASE_URL;
const here=dirname(fileURLToPath(import.meta.url));

test("PostgreSQL outbox fences delivery start, orders cancellation, retries safely and reconciles uncertain/dead outcomes",{
 skip:!connectionString
},async()=>{
 const {Pool}=await import("pg");
 const schema="kratt_wave3_delivery_"+randomUUID().replaceAll("-","");
 const admin=new Pool({connectionString,max:2});
 let pool;
 try{
  await admin.query("CREATE SCHEMA "+schema);
  pool=new Pool({connectionString,max:8,options:"-c search_path="+schema});
  const base=await readFile(join(here,"../migrations/0001_postgres_outbox.sql"),"utf8");
  const fabric=await readFile(join(here,"../migrations/0004_fabric_outbound.sql"),"utf8");
  const reliability=await readFile(join(here,"../migrations/0006_outbox_delivery_reliability.sql"),"utf8");
  await pool.query(base);await pool.query(fabric);await pool.query(reliability);await pool.query(reliability);
  let now=Date.parse("2026-11-26T12:00:00.000Z");
  const store=createPostgresOutboxStore(pool,{
   clock:()=>new Date(now),
   authorizeReconciliation:async request=>request.actorId==="security-admin"&&request.evidenceDigest==="e".repeat(64)
  });
  async function seed(taskId,tail){
   const idempotencyKey="kratt:"+taskId+":"+tail.repeat(64);
   const outboxId="outbox:"+taskId;
   const at=new Date(now).toISOString();
   await pool.query("INSERT INTO kratt_dispatch_intents(idempotency_key,task_id,actor_id,provider,operation,status,created_at) VALUES($1,$2,'operator-01','fabric','fabric.publish','INTENT_COMMITTED',$3)",
    [idempotencyKey,taskId,at]);
   await pool.query("INSERT INTO kratt_dispatch_outbox(outbox_id,idempotency_key,provider,payload,status,available_at) VALUES($1,$2,'fabric',$3::jsonb,'PENDING',$4)",
    [outboxId,idempotencyKey,JSON.stringify({event_id:taskId}),at]);
   return{taskId,idempotencyKey,outboxId};
  }
  async function claimOne(workerId="worker-01"){
   const rows=await store.claimOutbox({workerId,limit:10,leaseSeconds:5});
   return rows;
  }

  // Cancellation after claim but before begin wins the task-scoped advisory lock.
  const cancelFirst=await seed("task-cancel-before-delivery","a");
  const claimedForCancel=await claimOne();
  assert.equal(claimedForCancel.length,1);
  assert.equal(claimedForCancel[0].task_id,cancelFirst.taskId);
  const cancelled=await store.cancelTaskWithReason({taskId:cancelFirst.taskId,actorId:"operator-01"});
  assert.equal(cancelled.ok,true,JSON.stringify(cancelled));
  assert.equal(cancelled.cancelled_outbox_count,1);
  const afterCancel=await store.beginOutboxDelivery({outboxId:cancelFirst.outboxId,leaseToken:claimedForCancel[0].lease_token});
  assert.equal(afterCancel.reason,"LEASE_LOST");
  const cancelRow=await pool.query("SELECT status FROM kratt_dispatch_outbox WHERE outbox_id=$1",[cancelFirst.outboxId]);
  assert.equal(cancelRow.rows[0].status,"CANCELLED");
  assert.deepEqual(await claimOne(),[]);

  // Exercise the real worker composition: cancellation wins after claim but before the delivery-start fence.
  const workerCancelled = await seed("task-worker-cancel-after-claim","h");
  let providerCalls = 0;
  const workerStore = {
   ...store,
   async claimOutbox(options) {
    const rows = await store.claimOutbox({ ...options, limit: 1 });
    if (rows.length) {
     const cancelled = await store.cancelTaskWithReason({ taskId: rows[0].task_id, actorId: "operator-01" });
     assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    }
    return rows;
   }
  };
  const worker = createOutboxWorker({
   store: workerStore, workerId: "worker-security-test", actorId: "worker-security-test",
   adapters: { fabric: { async dispatch() { providerCalls += 1; return { status: "accepted" }; } } }
  });
  const workerRun = await worker.runOnce({ limit: 1, leaseSeconds: 5 });
  assert.equal(workerRun.claimed, 1);
  assert.equal(providerCalls, 0);
  assert.equal(workerRun.results[0].status, "LEASE_LOST");
  assert.equal(workerRun.results[0].dispatched, false);
  const workerCancelledRow = await pool.query("SELECT status,delivery_started_at FROM kratt_dispatch_outbox WHERE outbox_id=$1", [workerCancelled.outboxId]);
  assert.equal(workerCancelledRow.rows[0].status, "CANCELLED");
  assert.equal(workerCancelledRow.rows[0].delivery_started_at, null);

  // Once a delivery has durably begun, cancellation is refused rather than falsely acknowledged.
  const started=await seed("task-delivery-started","b");
  const claimed=await claimOne();
  assert.equal(claimed.length,1);
  const begun=await store.beginOutboxDelivery({outboxId:started.outboxId,leaseToken:claimed[0].lease_token});
  assert.equal(begun.ok,true,JSON.stringify(begun));
  const duplicateBegin=await store.beginOutboxDelivery({outboxId:started.outboxId,leaseToken:claimed[0].lease_token});
  assert.equal(duplicateBegin.ok,true);assert.equal(duplicateBegin.duplicate,true);
  const refusedCancel=await store.cancelTaskWithReason({taskId:started.taskId,actorId:"operator-01"});
  assert.equal(refusedCancel.reason,"DELIVERY_ALREADY_STARTED");
  const finished=await store.finishOutbox({
   outboxId:started.outboxId,leaseToken:claimed[0].lease_token,outcome:{status:"COMPLETED"},
   actorId:"worker-01",taskId:started.taskId
  });
  assert.equal(finished.ok,true,JSON.stringify(finished));
  assert.equal((await store.cancelTaskWithReason({taskId:started.taskId,actorId:"operator-01"})).reason,"TASK_ALREADY_TERMINAL");

  // Retry only follows a known-safe provider outcome; backoff is bounded and max attempts dead-letter.
  const retry=await seed("task-retry-dead-letter","c");
  let claim=await claimOne();
  assert.equal(claim.length,1);
  assert.equal((await store.beginOutboxDelivery({outboxId:retry.outboxId,leaseToken:claim[0].lease_token})).ok,true);
  const retryOne=await store.retryOutbox({
   outboxId:retry.outboxId,leaseToken:claim[0].lease_token,errorCode:"PROVIDER_TEMPORARY",
   maxAttempts:2,retrySafety:"SAFE_TO_RETRY"
  });
  assert.equal(retryOne.status,"PENDING");assert.equal(retryOne.retry_at,new Date(now+2000).toISOString());
  assert.deepEqual(await claimOne(),[]);
  now+=2000;
  claim=await claimOne();assert.equal(claim.length,1);assert.equal(claim[0].attempts,2);
  assert.equal((await store.beginOutboxDelivery({outboxId:retry.outboxId,leaseToken:claim[0].lease_token})).ok,true);
  const dead=await store.retryOutbox({
   outboxId:retry.outboxId,leaseToken:claim[0].lease_token,errorCode:"PROVIDER_TEMPORARY",
   maxAttempts:2,retrySafety:"SAFE_TO_RETRY"
  });
  assert.equal(dead.status,"DEAD");assert.equal(dead.terminal,true);
  const denied=await store.reconcileOutbox({
   outboxId:retry.outboxId,actorId:"untrusted-user",decision:"SAFE_TO_RETRY",
   evidenceDigest:"e".repeat(64),reason:"untrusted operator request"
  });
  assert.equal(denied.reason,"RECONCILIATION_DENIED");
  const requeued=await store.reconcileOutbox({
   outboxId:retry.outboxId,actorId:"security-admin",decision:"SAFE_TO_RETRY",
   evidenceDigest:"e".repeat(64),reason:"verified receiver deduplication and retry safety"
  });
  assert.equal(requeued.ok,true,JSON.stringify(requeued));
  const reset=await pool.query("SELECT status,attempts,manual_reconciliation_count FROM kratt_dispatch_outbox WHERE outbox_id=$1",[retry.outboxId]);
  assert.equal(reset.rows[0].status,"PENDING");assert.equal(reset.rows[0].attempts,0);assert.equal(reset.rows[0].manual_reconciliation_count,1);
  claim=await claimOne();assert.equal(claim.length,1);
  assert.equal((await store.beginOutboxDelivery({outboxId:retry.outboxId,leaseToken:claim[0].lease_token})).ok,true);
  assert.equal((await store.finishOutbox({
   outboxId:retry.outboxId,leaseToken:claim[0].lease_token,outcome:{status:"COMPLETED"},
   actorId:"worker-01",taskId:retry.taskId
  })).ok,true);

  // Unknown delivery outcome is never automatically retried; it goes to RECONCILE.
  const unknown=await seed("task-unknown-delivery","d");
  claim=await claimOne();assert.equal(claim.length,1);
  assert.equal((await store.beginOutboxDelivery({outboxId:unknown.outboxId,leaseToken:claim[0].lease_token})).ok,true);
  const uncertain=await store.retryOutbox({
   outboxId:unknown.outboxId,leaseToken:claim[0].lease_token,errorCode:"NETWORK_TIMEOUT",
   retrySafety:"UNKNOWN"
  });
  assert.equal(uncertain.status,"RECONCILE");assert.equal(uncertain.reconciliation_required,true);
  assert.deepEqual(await claimOne(),[]);
  const confirmed=await store.reconcileOutbox({
   outboxId:unknown.outboxId,actorId:"security-admin",decision:"CONFIRMED_DELIVERED",
   evidenceDigest:"e".repeat(64),reason:"verified signed receiver acknowledgement"
  });
  assert.equal(confirmed.ok,true,JSON.stringify(confirmed));
  const confirmedRow=await pool.query(
   "SELECT o.status,i.status AS intent_status FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i USING(idempotency_key) WHERE o.outbox_id=$1",
   [unknown.outboxId]
  );
  assert.equal(confirmedRow.rows[0].status,"DONE");assert.equal(confirmedRow.rows[0].intent_status,"COMPLETED");

  // Expired lease before delivery can be safely re-claimed; stale lease tokens are fenced out.
  const expiredBefore=await seed("task-expired-before-delivery","f");
  claim=await claimOne();assert.equal(claim.length,1);
  const staleToken=claim[0].lease_token;
  now+=6000;
  const reclaimed=await claimOne();
  assert.equal(reclaimed.length,1);assert.equal(reclaimed[0].task_id,expiredBefore.taskId);
  assert.notEqual(reclaimed[0].lease_token,staleToken);
  assert.equal((await store.beginOutboxDelivery({outboxId:expiredBefore.outboxId,leaseToken:staleToken})).reason,"LEASE_LOST");
  assert.equal((await store.beginOutboxDelivery({outboxId:expiredBefore.outboxId,leaseToken:reclaimed[0].lease_token})).ok,true);
  assert.equal((await store.finishOutbox({
   outboxId:expiredBefore.outboxId,leaseToken:reclaimed[0].lease_token,outcome:{status:"COMPLETED"},
   actorId:"worker-01",taskId:expiredBefore.taskId
  })).ok,true);

  // Expired lease after delivery started is ambiguous and becomes RECONCILE, never a blind resend.
  const expiredAfter=await seed("task-expired-after-delivery-start","g");
  claim=await claimOne();assert.equal(claim.length,1);
  assert.equal((await store.beginOutboxDelivery({outboxId:expiredAfter.outboxId,leaseToken:claim[0].lease_token})).ok,true);
  now+=6000;
  const afterLeaseExpiry=await claimOne();
  assert.deepEqual(afterLeaseExpiry,[]);
  const ambiguous=await pool.query("SELECT status,last_error_code,delivery_started_at FROM kratt_dispatch_outbox WHERE outbox_id=$1",[expiredAfter.outboxId]);
  assert.equal(ambiguous.rows[0].status,"RECONCILE");
  assert.equal(ambiguous.rows[0].last_error_code,"DELIVERY_LEASE_EXPIRED_AFTER_START");
  assert.ok(ambiguous.rows[0].delivery_started_at);
  const reconciliation=await store.reconcileOutbox({
   outboxId:expiredAfter.outboxId,actorId:"security-admin",decision:"CANCELLED",
   evidenceDigest:"e".repeat(64),reason:"receiver confirms no commit and operator cancels"
  });
  assert.equal(reconciliation.ok,true,JSON.stringify(reconciliation));

  await assert.rejects(
   pool.query("UPDATE kratt_dispatch_outbox_reconciliations SET reason='forged' WHERE reconciliation_id=$1",[reconciliation.reconciliation_id]),
   /KRATT_OUTBOX_RECONCILIATION_APPEND_ONLY/
  );
  await assert.rejects(
   pool.query("DELETE FROM kratt_cancelled_tasks WHERE task_id=$1",[cancelFirst.taskId]),
   /KRATT_CANCELLED_TASK_APPEND_ONLY/
  );
  const counts=await pool.query("SELECT count(*)::int AS reconciliation_count FROM kratt_dispatch_outbox_reconciliations");
  assert.equal(counts.rows[0].reconciliation_count,3);
 }finally{
  await pool?.end();
  await admin.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>undefined);
  await admin.end();
 }
});
