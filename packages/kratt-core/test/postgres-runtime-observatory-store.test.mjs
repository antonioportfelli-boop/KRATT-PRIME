import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresRuntimeObservatoryStore } from "../src/postgres-runtime-observatory-store.mjs";

const ZERO="0".repeat(64);
const t0="2026-11-19T10:00:00.000Z",t1="2026-11-19T10:00:01.000Z",t2="2026-11-19T10:00:03.000Z";
function event(status,overrides={}){
 return{
  schema_version:"kratt-runtime-operation/v1",
  event_id:"event-"+status,event_type:"operation."+status,operation_id:"operation-01",
  correlation_id:"correlation-01",module_id:"kratt-core",adapter_id:"postgres-store",
  capability:"runtime-observatory",capability_state:"bound",status,
  occurred_at:status==="queued"?t0:status==="running"?t1:t2,
  started_at:status==="queued"?null:t1,
  finished_at:["succeeded","failed","cancelled","timed_out","not_run"].includes(status)?(status==="not_run"?t0:t2):null,
  duration_ms:status==="succeeded"?2000:null,input_ref:"input:sha256:aaaaaaaa",
  output_ref:status==="succeeded"?"artifact:sha256:bbbbbbbb":null,evidence_refs:[],
  environment:"test",runtime_version:"node22.0.0",...overrides,
 };
}
class FakePool{
 constructor(){this.head={sequence:0,hash:ZERO};this.events=[];this.operations=new Map();}
 async connect(){return{query:(sql,values=[])=>this.query(sql,values),release(){}};}
 async query(raw,values=[]){
  const sql=raw.replace(/\s+/g," ").trim();
  if(["BEGIN","COMMIT","ROLLBACK","BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(sql))
   return{rowCount:0,rows:[]};
  if(sql.startsWith("SELECT sequence,hash FROM kratt_runtime_observatory_head"))
   return{rowCount:1,rows:[{...this.head}]};
  if(sql.startsWith("SELECT sequence,hash,record_json FROM kratt_runtime_operation_events")){
   const row=this.events.find(item=>item.event_id===values[0]);
   return{rowCount:row?1:0,rows:row?[row]:[]};
  }
  if(sql.startsWith("SELECT * FROM kratt_runtime_operations WHERE operation_id=")){
   const row=this.operations.get(values[0]);return{rowCount:row?1:0,rows:row?[row]:[]};
  }
  if(sql.startsWith("INSERT INTO kratt_runtime_operation_events")){
   const [sequence,event_id,operation_id,event_type,occurred_at,record_json,previous_hash,hash]=values;
   this.events.push({sequence,event_id,operation_id,event_type,occurred_at:new Date(occurred_at),
    record_json:JSON.parse(record_json),previous_hash,hash});
   return{rowCount:1,rows:[]};
  }
  if(sql.startsWith("INSERT INTO kratt_runtime_operations")){
   const [operation_id,correlation_id,module_id,adapter_id,capability,capability_state,status,queued_at,
    started_at,finished_at,duration_ms,input_ref,output_ref,evidence_refs,environment,runtime_version,
    last_occurred_at,last_event_id,last_sequence]=values;
   this.operations.set(operation_id,{
    operation_id,correlation_id,module_id,adapter_id,capability,capability_state,status,
    queued_at:new Date(queued_at),started_at:started_at?new Date(started_at):null,
    finished_at:finished_at?new Date(finished_at):null,duration_ms,input_ref,output_ref,
    evidence_refs:JSON.parse(evidence_refs),environment,runtime_version,
    last_occurred_at:new Date(last_occurred_at),last_event_id,last_sequence,
   });
   return{rowCount:1,rows:[]};
  }
  if(sql.startsWith("UPDATE kratt_runtime_observatory_head")){
   this.head={sequence:values[0],hash:values[1]};return{rowCount:1,rows:[]};
  }
  if(sql.startsWith("SELECT sequence,event_id,operation_id,event_type,occurred_at,record_json,previous_hash,hash FROM kratt_runtime_operation_events")){
   return{rowCount:this.events.length,rows:[...this.events].sort((a,b)=>a.sequence-b.sequence)};
  }
  if(sql.startsWith("SELECT operation_id,status,last_event_id,last_sequence FROM kratt_runtime_operations")){
   const rows=[...this.operations.values()].map(x=>({operation_id:x.operation_id,status:x.status,last_event_id:x.last_event_id,last_sequence:x.last_sequence}));
   return{rowCount:rows.length,rows};
  }
  if(sql.startsWith("SELECT * FROM kratt_runtime_operations WHERE operation_id=")){
   const row=this.operations.get(values[0]);return{rowCount:row?1:0,rows:row?[row]:[]};
  }
  if(sql.startsWith("SELECT sequence,event_id,record_json,previous_hash,hash FROM kratt_runtime_operation_events")){
   const rows=this.events.filter(x=>x.operation_id===values[0]).sort((a,b)=>b.sequence-a.sequence).slice(0,values[1]);
   return{rowCount:rows.length,rows};
  }
  throw new Error("UNEXPECTED_SQL:"+sql);
 }
}
test("PostgreSQL store appends lifecycle events, projects latest state and verifies hash chain",async()=>{
 const pool=new FakePool(),store=createPostgresRuntimeObservatoryStore(pool);
 const queued=await store.append(event("queued"));
 assert.equal(queued.ok,true);assert.equal(queued.sequence,1);
 const running=await store.append(event("running"));
 assert.equal(running.ok,true);assert.equal(running.sequence,2);
 const done=await store.append(event("succeeded"));
 assert.equal(done.ok,true);assert.equal(done.sequence,3);
 const current=await store.getOperation("operation-01");
 assert.equal(current.status,"succeeded");
 assert.equal(current.duration_ms,2000);
 assert.equal(current.last_sequence,3);
 const history=await store.listEvents("operation-01");
 assert.deepEqual(history.map(item=>item.event.status),["queued","running","succeeded"]);
 assert.deepEqual(await store.verifyChain(),{
  ok:true,count:3,operations:1,head_hash:pool.head.hash,
 });
});
test("duplicate event IDs are idempotent only when the canonical event is identical",async()=>{
 const pool=new FakePool(),store=createPostgresRuntimeObservatoryStore(pool);
 const first=await store.append(event("queued"));
 const repeated=await store.append(event("queued"));
 assert.equal(first.ok,true);
 assert.equal(repeated.ok,true);
 assert.equal(repeated.duplicate,true);
 const conflict=await store.append(event("queued",{correlation_id:"another-correlation"}));
 assert.equal(conflict.ok,false);
 assert.equal(conflict.reason,"OBSERVATORY_EVENT_ID_CONFLICT");
 assert.equal(pool.events.length,1);
});
test("store rejects invalid status order and fails closed without a head row",async()=>{
 const pool=new FakePool(),store=createPostgresRuntimeObservatoryStore(pool);
 const invalid=await store.append(event("succeeded"));
 assert.equal(invalid.ok,false);
 assert.equal(pool.events.length,0);
 const noHead=new FakePool();noHead.head=null;
 noHead.query=async function(raw,values=[]){
  const sql=raw.replace(/\s+/g," ").trim();
  if(sql.startsWith("SELECT sequence,hash FROM kratt_runtime_observatory_head"))
   return{rowCount:0,rows:[]};
  return FakePool.prototype.query.call(this,raw,values);
 };
 const result=await createPostgresRuntimeObservatoryStore(noHead).append(event("queued"));
 assert.equal(result.ok,false);
 assert.equal(result.reason,"OBSERVATORY_HEAD_NOT_INITIALIZED");
});
test("integrity verification detects a changed event hash",async()=>{
 const pool=new FakePool(),store=createPostgresRuntimeObservatoryStore(pool);
 await store.append(event("queued"));await store.append(event("running"));
 pool.events[0].hash="f".repeat(64);
 const result=await store.verifyChain();
 assert.equal(result.ok,false);
 assert.equal(result.reason,"EVENT_CHAIN_INVALID");
});

test("listEvents applies a descending sequence cursor",async()=>{const pool=new FakePool(),store=createPostgresRuntimeObservatoryStore(pool);await store.append(event("queued"));await store.append(event("running"));const rows=await store.listEvents("operation-01",{limit:1,beforeSequence:2});assert.equal(rows.length,1);assert.equal(rows[0].event.status,"queued");});
