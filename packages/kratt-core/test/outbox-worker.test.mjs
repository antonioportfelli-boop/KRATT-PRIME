import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxWorker } from "../src/outbox-worker.mjs";

const item={outbox_id:"outbox-01",idempotency_key:"kratt:task-01:"+"a".repeat(64),
 provider:"github",payload:{task:{task_id:"task-01"}},attempts:1,lease_token:"lease-01"};

test("worker forwards stable idempotency key and records a provider result",async()=>{
 const calls=[];
 const worker=createOutboxWorker({
  store:{claimOutbox:async()=>[item],finishOutbox:async input=>{calls.push(["finish",input]);return{ok:true};},
   retryOutbox:async input=>{calls.push(["retry",input]);return{ok:true};}},
  adapters:{github:{dispatch:async input=>{calls.push(["dispatch",input]);return{status:"completed"};}}},
  workerId:"worker-01",actorId:"worker-service",
 });
 const result=await worker.runOnce();
 assert.equal(result.claimed,1);assert.equal(result.results[0].status,"RECORDED");
 assert.equal(calls[0][1].idempotencyKey,item.idempotency_key);
 assert.equal(calls[1][1].taskId,"task-01");
});

test("worker retries safely when provider adapter is absent",async()=>{
 const calls=[];
 const worker=createOutboxWorker({
  store:{claimOutbox:async()=>[item],finishOutbox:async()=>({ok:true}),
   retryOutbox:async input=>{calls.push(input);return{ok:true,terminal:false};}},
  adapters:{},workerId:"worker-02",actorId:"worker-service",maxAttempts:2,
 });
 const result=await worker.runOnce();
 assert.equal(result.results[0].status,"RETRY_SCHEDULED");
 assert.equal(calls[0].errorCode,"PROVIDER_ADAPTER_UNAVAILABLE");
});

test("worker retries provider exceptions rather than reporting success",async()=>{
 const calls=[];
 const worker=createOutboxWorker({
  store:{claimOutbox:async()=>[item],finishOutbox:async()=>{throw new Error("must not finish");},
   retryOutbox:async input=>{calls.push(input);return{ok:true,terminal:false};}},
  adapters:{github:{dispatch:async()=>{throw new Error("provider unavailable");}}},
  workerId:"worker-03",actorId:"worker-service",maxAttempts:3,
 });
 const result=await worker.runOnce();
 assert.equal(result.results[0].status,"RETRY_SCHEDULED");
 assert.equal(calls[0].errorCode,"PROVIDER_DISPATCH_FAILED");
});
