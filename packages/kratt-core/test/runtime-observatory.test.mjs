import test from "node:test";
import assert from "node:assert/strict";
import {
 createOperationEvent,validateOperationEvent,validateOperationTransition,
 projectOperation,runtimeOperationHash,summarizeModules,
} from "../src/runtime-observatory.mjs";

const t0="2026-11-19T10:00:00.000Z";
const t1="2026-11-19T10:00:02.000Z";
const t2="2026-11-19T10:00:05.000Z";
function event(status,overrides={}){
 const started=["running","succeeded","failed","cancelled","timed_out"].includes(status)?t1:null;
 const finished=["succeeded","failed","cancelled","timed_out","not_run"].includes(status)?(status==="not_run"?t0:t2):null;
 return{
  schema_version:"kratt-runtime-operation/v1",
  event_id:"event-"+status,event_type:"operation."+status,
  operation_id:"operation-01",correlation_id:"correlation-01",module_id:"kratt-core",
  adapter_id:"postgres-store",capability:"runtime-observatory",capability_state:"bound",
  status,occurred_at:status==="queued"?t0:status==="not_run"?t0:status==="running"?t1:t2,
  started_at:started,finished_at:finished,
  duration_ms:["succeeded","failed","cancelled","timed_out"].includes(status)?3000:null,
  input_ref:"input:sha256:aaaaaaaa",output_ref:status==="succeeded"?"artifact:sha256:bbbbbbbb":null,
  evidence_refs:[],environment:"test",runtime_version:"node22.0.0",
  ...overrides,
 };
}
test("valid operation lifecycle is queued -> running -> succeeded with measured duration",()=>{
 const queued=createOperationEvent(event("queued"));
 const running=validateOperationTransition({...projectOperation(queued,1),last_occurred_at:t0},event("running"));
 assert.equal(running.ok,true);
 const done=validateOperationTransition({...projectOperation(running.value,2),last_occurred_at:t1},event("succeeded"));
 assert.equal(done.ok,true);
 assert.equal(done.value.duration_ms,3000);
});
test("terminal states cannot transition and a missing queue event is rejected",()=>{
 assert.equal(validateOperationTransition(null,event("running")).reason,
  "OBSERVATORY_INITIAL_STATE_MUST_BE_QUEUED_OR_NOT_RUN");
 const queued=createOperationEvent(event("queued"));
 const done=validateOperationTransition({...projectOperation(queued,1),last_occurred_at:t0},event("succeeded"));
 assert.equal(done.ok,false);
 assert.equal(done.reason,"OBSERVATORY_INVALID_STATUS_TRANSITION");
});
test("operation identity and capability metadata cannot mutate mid-flight",()=>{
 const queued=createOperationEvent(event("queued"));
 const altered=event("running",{module_id:"other-module"});
 const result=validateOperationTransition({...projectOperation(queued,1),last_occurred_at:t0},altered);
 assert.equal(result.ok,false);
 assert.equal(result.reason,"OBSERVATORY_OPERATION_METADATA_CHANGED");
});
test("timestamps and duration must match actual lifecycle timestamps",()=>{
 assert.equal(validateOperationEvent(event("succeeded",{duration_ms:999})).ok,false);
 assert.equal(validateOperationEvent(event("running",{started_at:t0})).ok,false);
 assert.equal(validateOperationEvent(event("queued",{duration_ms:0})).ok,false);
});
test("events reject undeclared fields, raw payloads and malformed evidence references",()=>{
 assert.equal(validateOperationEvent(event("queued",{payload:{secret:"do-not-store"}})).ok,false);
 assert.equal(validateOperationEvent(event("queued",{input_ref:"https://example.com/private"})).ok,false);
 assert.equal(validateOperationEvent(event("queued",{evidence_refs:[{kind:"log",ref:"https://example.com?token=x",digest:null}]})).ok,false);
 assert.equal(validateOperationEvent(event("queued",{evidence_refs:[{kind:"log",ref:"log:run-1",digest:null,body:"raw"}]})).ok,false);
});
test("not_run is a truthful initial terminal state with no fabricated runtime duration",()=>{
 const noRun=event("not_run");
 assert.equal(validateOperationEvent(noRun).ok,true);
 assert.equal(validateOperationEvent({...noRun,duration_ms:1}).ok,false);
});
test("hash-chain output binds sequence, predecessor and canonical event fields",()=>{
 const queued=createOperationEvent(event("queued"));
 const first=runtimeOperationHash(1,"0".repeat(64),queued);
 const second=runtimeOperationHash(2,first,event("running"));
 assert.match(first,/^[a-f0-9]{64}$/);
 assert.notEqual(first,second);
 assert.notEqual(first,runtimeOperationHash(2,"0".repeat(64),queued));
});
test("module summaries count real statuses and only average measured successful durations",()=>{
 const rows=[
  {...projectOperation(event("succeeded"),1),duration_ms:3000},
  {...projectOperation(event("failed",{duration_ms:3000}),2),duration_ms:3000},
  {...projectOperation(event("queued"),3),duration_ms:null},
 ];
 rows[1]={...rows[1],operation_id:"operation-02"};
 rows[2]={...rows[2],operation_id:"operation-03"};
 const [summary]=summarizeModules(rows);
 assert.equal(summary.total,3);
 assert.equal(summary.status_counts.succeeded,1);
 assert.equal(summary.status_counts.failed,1);
 assert.equal(summary.status_counts.queued,1);
 assert.equal(summary.average_success_duration_ms,3000);
});

test("malformed previous operation status is rejected",()=>{const previous={...projectOperation(event("queued"),1),status:"unknown"};assert.equal(validateOperationTransition(previous,event("running")).ok,false);});
