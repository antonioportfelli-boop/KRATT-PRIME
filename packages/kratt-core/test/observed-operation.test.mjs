import test from "node:test";
import assert from "node:assert/strict";
import { createObservedOperationRunner } from "../src/observed-operation.mjs";

const base={
 operation_id:"op-100",correlation_id:"corr-100",module_id:"telegram-ingress",
 adapter_id:"postgres-ingress",capability:"telegram.webhook.ingest",
 capability_state:"bound",environment:"test",runtime_version:"node22.0.0",
 input_ref:"update:sha256:aaaaaaaa",evidence_refs:[],
};
test("observed runner records the real queue, start and success lifecycle",async()=>{
 const events=[];let now=0;
 const runner=createObservedOperationRunner({
  store:{append:async event=>{events.push(event);return{ok:true};}},
  clock:()=>new Date(Date.parse("2026-11-19T10:00:00.000Z")+now),
  makeEventId:(()=>{let n=0;return()=> "event-"+(++n);})(),
 });
 const result=await runner.run({...base,execute:async()=>{now=250;return{accepted:true};},outputRef:()=> "snapshot:sha256:bbbbbbbb"});
 assert.equal(result.status,"COMPLETED");
 assert.deepEqual(events.map(e=>e.status),["queued","running","succeeded"]);
 assert.equal(events[2].duration_ms,250);
 assert.equal(events[2].output_ref,"snapshot:sha256:bbbbbbbb");
});
test("observed runner never executes when it cannot durably record the queue",async()=>{
 let executed=false;
 const runner=createObservedOperationRunner({store:{append:async()=>({ok:false})}});
 const result=await runner.run({...base,execute:async()=>{executed=true;}});
 assert.equal(result.status,"BLOCKED");
 assert.equal(executed,false);
});
test("failed and cancelled operations are recorded without serializing raw errors",async()=>{
 const events=[];let tick=0;
 const runner=createObservedOperationRunner({
  store:{append:async event=>{events.push(event);return{ok:true};}},
  clock:()=>new Date(Date.parse("2026-11-19T10:00:00.000Z")+tick++*100),
 });
 const result=await runner.run({...base,execute:async()=>{const error=new Error("secret token must not appear");error.name="AbortError";throw error;}});
 assert.equal(result.status,"CANCELLED");
 assert.equal(events.at(-1).status,"cancelled");
 assert.doesNotMatch(JSON.stringify(events),/secret token/);
});
test("an executed operation with an unrecordable terminal event is never reported as completed",async()=>{
 let calls=0;
 const runner=createObservedOperationRunner({store:{append:async()=>({ok:++calls<3})}});
 const result=await runner.run({...base,execute:async()=>42});
 assert.equal(result.status,"OUTCOME_UNRECORDED");
 assert.equal(result.executed,true);
});

test("duplicate append acknowledgement remains idempotently successful",async()=>{let n=0,t=0;const runner=createObservedOperationRunner({store:{append:async()=>({ok:true,duplicate:++n>1})},clock:()=>new Date(Date.parse("2026-11-19T10:00:00.000Z")+t++*10)});const result=await runner.run({...base,execute:async()=>42,outputRef:()=>"output:sha256:aaaaaaaa"});assert.equal(result.status,"COMPLETED");});
test("null output references cannot be reported completed",async()=>{const runner=createObservedOperationRunner({store:{append:async()=>({ok:true})}});const result=await runner.run({...base,execute:async()=>42,outputRef:()=>null});assert.equal(result.status,"OUTCOME_UNRECORDED");});
