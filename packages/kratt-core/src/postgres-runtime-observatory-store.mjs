import {
 createOperationEvent,validateOperationTransition,projectOperation,
 runtimeOperationHash,stableOperationJson,
} from "./runtime-observatory.mjs";

const ZERO="0".repeat(64);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function parseJson(value){
 if(typeof value==="string"){try{return JSON.parse(value);}catch{return null;}}
 return value&&typeof value==="object"?value:null;
}
function asIso(value){
 if(value===null||value===undefined)return null;
 const date=value instanceof Date?value:new Date(value);
 return Number.isFinite(date.getTime())?date.toISOString():null;
}
function fromRow(row){
 if(!row)return null;
 return{
  operation_id:row.operation_id,correlation_id:row.correlation_id,module_id:row.module_id,
  adapter_id:row.adapter_id,capability:row.capability,capability_state:row.capability_state,
  status:row.status,queued_at:asIso(row.queued_at),started_at:asIso(row.started_at),
  finished_at:asIso(row.finished_at),duration_ms:row.duration_ms===null?null:Number(row.duration_ms),
  input_ref:row.input_ref,output_ref:row.output_ref,evidence_refs:parseJson(row.evidence_refs)??[],
  environment:row.environment,runtime_version:row.runtime_version,
  last_occurred_at:asIso(row.last_occurred_at),last_event_id:row.last_event_id,
  last_sequence:Number(row.last_sequence),
 };
}
async function transaction(pool,work){
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const result=await work(client);
  if(result===false||(result&&result.ok===false)){await client.query("ROLLBACK");return result;}
  await client.query("COMMIT");return result;
 }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}
 finally{client.release();}
}

export function createPostgresRuntimeObservatoryStore(pool){
 if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")
  throw new TypeError("OBSERVATORY_POSTGRES_POOL_REQUIRED");

 async function append(input){
  let event;
  try{event=createOperationEvent(input);}catch(error){return{ok:false,reason:error.message};}
  const canonical=stableOperationJson(event);
  const eventDigest=canonical;
  return transaction(pool,async client=>{
   const headResult=await client.query(
    "SELECT sequence,hash FROM kratt_runtime_observatory_head WHERE singleton=TRUE FOR UPDATE");
   const head=headResult.rows?.[0];
   if(!head)return{ok:false,reason:"OBSERVATORY_HEAD_NOT_INITIALIZED"};
   const duplicate=await client.query(
    "SELECT sequence,hash,record_json FROM kratt_runtime_operation_events WHERE event_id=$1",
    [event.event_id]);
   if(duplicate.rowCount===1){
    const prior=parseJson(duplicate.rows[0].record_json);
    if(prior&&stableOperationJson(prior)===eventDigest)
     return{ok:true,duplicate:true,sequence:Number(duplicate.rows[0].sequence),hash:String(duplicate.rows[0].hash).trim()};
    return{ok:false,reason:"OBSERVATORY_EVENT_ID_CONFLICT"};
   }
   const currentResult=await client.query(
    "SELECT * FROM kratt_runtime_operations WHERE operation_id=$1 FOR UPDATE",[event.operation_id]);
   const previous=fromRow(currentResult.rows?.[0]);
   const transition=validateOperationTransition(previous,event);
   if(!transition.ok)return{ok:false,reason:transition.reason};
   const sequence=Number(head.sequence)+1;
   const previousHash=String(head.hash).trim();
   if(!Number.isSafeInteger(sequence)||sequence<1||! /^[a-f0-9]{64}$/.test(previousHash))
    return{ok:false,reason:"OBSERVATORY_HEAD_INVALID"};
   const hash=runtimeOperationHash(sequence,previousHash,event);
   const projection=projectOperation(event,sequence,previous);
   await client.query(
    "INSERT INTO kratt_runtime_operation_events(sequence,event_id,operation_id,event_type,occurred_at,record_json,previous_hash,hash) "+
    "VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
    [sequence,event.event_id,event.operation_id,event.event_type,event.occurred_at,canonical,previousHash,hash]);
   await client.query(
    "INSERT INTO kratt_runtime_operations(operation_id,correlation_id,module_id,adapter_id,capability,capability_state,status,queued_at,started_at,finished_at,duration_ms,input_ref,output_ref,evidence_refs,environment,runtime_version,last_occurred_at,last_event_id,last_sequence,updated_at) "+
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$17) "+
    "ON CONFLICT(operation_id) DO UPDATE SET correlation_id=EXCLUDED.correlation_id,module_id=EXCLUDED.module_id,adapter_id=EXCLUDED.adapter_id,capability=EXCLUDED.capability,capability_state=EXCLUDED.capability_state,status=EXCLUDED.status,queued_at=EXCLUDED.queued_at,started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at,duration_ms=EXCLUDED.duration_ms,input_ref=EXCLUDED.input_ref,output_ref=EXCLUDED.output_ref,evidence_refs=EXCLUDED.evidence_refs,environment=EXCLUDED.environment,runtime_version=EXCLUDED.runtime_version,last_occurred_at=EXCLUDED.last_occurred_at,last_event_id=EXCLUDED.last_event_id,last_sequence=EXCLUDED.last_sequence,updated_at=EXCLUDED.updated_at",
    [projection.operation_id,projection.correlation_id,projection.module_id,projection.adapter_id,
     projection.capability,projection.capability_state,projection.status,projection.queued_at,
     projection.started_at,projection.finished_at,projection.duration_ms,projection.input_ref,
     projection.output_ref,JSON.stringify(projection.evidence_refs),projection.environment,
     projection.runtime_version,projection.last_occurred_at,projection.last_event_id,sequence]);
   await client.query(
    "UPDATE kratt_runtime_observatory_head SET sequence=$1,hash=$2 WHERE singleton=TRUE",
    [sequence,hash]);
   return{ok:true,duplicate:false,sequence,hash,operation:projection};
  });
 }

 async function getOperation(operationId){
  if(!ID.test(operationId??""))throw new TypeError("OBSERVATORY_OPERATION_ID_INVALID");
  const result=await pool.query("SELECT * FROM kratt_runtime_operations WHERE operation_id=$1",[operationId]);
  return fromRow(result.rows?.[0]??null);
 }

 async function listOperations({moduleId,status,limit=50}={}){
  if(moduleId!==undefined&&!ID.test(moduleId??""))throw new TypeError("OBSERVATORY_MODULE_ID_INVALID");
  const statuses=["queued","running","succeeded","failed","cancelled","timed_out","not_run"];
  if(status!==undefined&&!statuses.includes(status))throw new TypeError("OBSERVATORY_STATUS_FILTER_INVALID");
  if(!Number.isInteger(limit)||limit<1||limit>200)throw new TypeError("OBSERVATORY_LIMIT_INVALID");
  const where=[],values=[];
  if(moduleId!==undefined){values.push(moduleId);where.push("module_id=$"+values.length);}
  if(status!==undefined){values.push(status);where.push("status=$"+values.length);}
  values.push(limit);
  const sql="SELECT * FROM kratt_runtime_operations"+(where.length?" WHERE "+where.join(" AND "):"")+
   " ORDER BY updated_at DESC,operation_id LIMIT $"+values.length;
  const result=await pool.query(sql,values);
  return(result.rows??[]).map(fromRow);
 }

 async function listEvents(operationId,{limit=100,beforeSequence}={}){
  if(!ID.test(operationId??""))throw new TypeError("OBSERVATORY_OPERATION_ID_INVALID");
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new TypeError("OBSERVATORY_EVENT_LIMIT_INVALID");
  if(beforeSequence!==undefined&&(!Number.isSafeInteger(beforeSequence)||beforeSequence<1))throw new TypeError("OBSERVATORY_EVENT_CURSOR_INVALID");
  const result=await pool.query(
   "SELECT sequence,event_id,record_json,previous_hash,hash FROM kratt_runtime_operation_events WHERE operation_id=$1 "+
   (beforeSequence===undefined?"":"AND sequence<$3 ")+
   "ORDER BY sequence DESC LIMIT $2",
   beforeSequence===undefined?[operationId,limit]:[operationId,limit,beforeSequence]);
  return(result.rows??[]).map(row=>({
   sequence:Number(row.sequence),event_id:row.event_id,event:parseJson(row.record_json),
   previous_hash:String(row.previous_hash).trim(),hash:String(row.hash).trim(),
  })).reverse();
 }

 async function summarizeModules(){
  const result=await pool.query(
   "SELECT module_id,COUNT(*)::bigint AS total,"+
   "COUNT(*) FILTER(WHERE status='queued')::bigint AS queued,"+
   "COUNT(*) FILTER(WHERE status='running')::bigint AS running,"+
   "COUNT(*) FILTER(WHERE status='succeeded')::bigint AS succeeded,"+
   "COUNT(*) FILTER(WHERE status='failed')::bigint AS failed,"+
   "COUNT(*) FILTER(WHERE status='cancelled')::bigint AS cancelled,"+
   "COUNT(*) FILTER(WHERE status='timed_out')::bigint AS timed_out,"+
   "COUNT(*) FILTER(WHERE status='not_run')::bigint AS not_run,"+
   "ROUND(AVG(duration_ms) FILTER(WHERE status='succeeded' AND duration_ms IS NOT NULL))::bigint AS average_success_duration_ms,"+
   "MAX(last_occurred_at) AS last_operation_at,"+
   "ARRAY_AGG(DISTINCT capability_state ORDER BY capability_state) AS capability_states "+
   "FROM kratt_runtime_operations GROUP BY module_id ORDER BY module_id");
  return(result.rows??[]).map(row=>({
   module_id:row.module_id,total:Number(row.total),
   status_counts:{
    queued:Number(row.queued),running:Number(row.running),succeeded:Number(row.succeeded),
    failed:Number(row.failed),cancelled:Number(row.cancelled),timed_out:Number(row.timed_out),
    not_run:Number(row.not_run),
   },
   capability_states:row.capability_states??[],
   average_success_duration_ms:row.average_success_duration_ms===null?null:Number(row.average_success_duration_ms),
   last_operation_at:asIso(row.last_operation_at),
  }));
 }

 async function checkReady(){
  try{
   const result=await verifyChain();
   return{ready:result.ok===true};
  }catch{return{ready:false};}
 }

 async function verifyChain(){
  const client=await pool.connect();let opened=false;
  try{
   await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");opened=true;
   const events=await client.query(
    "SELECT sequence,event_id,operation_id,event_type,occurred_at,record_json,previous_hash,hash FROM kratt_runtime_operation_events ORDER BY sequence");
   const head=await client.query("SELECT sequence,hash FROM kratt_runtime_observatory_head WHERE singleton=TRUE");
   const projections=await client.query(
    "SELECT operation_id,status,last_event_id,last_sequence FROM kratt_runtime_operations");
   await client.query("COMMIT");opened=false;
   let previousHash=ZERO,expected=1;
   const latest=new Map();
   for(const row of events.rows??[]){
    const sequence=Number(row.sequence);
    let event;
    try{event=createOperationEvent(parseJson(row.record_json));}catch{
     return{ok:false,count:events.rows.length,broken_sequence:sequence,reason:"EVENT_SCHEMA_INVALID"};
    }
    const occurredAt=asIso(row.occurred_at);
    const prior=latest.get(event.operation_id)??null;
    const transition=validateOperationTransition(prior,event);
    const calculated=runtimeOperationHash(sequence,previousHash,event);
    if(sequence!==expected||!transition.ok||row.event_id!==event.event_id||
     row.operation_id!==event.operation_id||row.event_type!==event.event_type||
     occurredAt!==event.occurred_at||String(row.previous_hash).trim()!==previousHash||
     String(row.hash).trim()!==calculated)
     return{ok:false,count:events.rows.length,broken_sequence:sequence,reason:"EVENT_CHAIN_INVALID"};
    latest.set(event.operation_id,projectOperation(event,sequence,prior));
    previousHash=calculated;expected++;
   }
   const currentHead=head.rows?.[0];
   if(!currentHead||Number(currentHead.sequence)!==events.rows.length||
    String(currentHead.hash).trim()!==previousHash)
    return{ok:false,count:events.rows?.length??0,broken_sequence:expected,reason:"HEAD_MISMATCH"};
   if((projections.rows??[]).length!==latest.size)
    return{ok:false,count:events.rows.length,broken_sequence:expected,reason:"PROJECTION_COUNT_MISMATCH"};
   for(const row of projections.rows??[]){
    const projection=latest.get(row.operation_id);
    if(!projection||projection.status!==row.status||projection.last_event_id!==row.last_event_id||
     projection.last_sequence!==Number(row.last_sequence))
     return{ok:false,count:events.rows.length,broken_sequence:projection?.last_sequence??expected,reason:"PROJECTION_MISMATCH"};
   }
   return{ok:true,count:events.rows.length,operations:latest.size,head_hash:previousHash};
  }catch{
   if(opened){try{await client.query("ROLLBACK");}catch{}}
   return{ok:false,reason:"OBSERVATORY_CHAIN_READ_FAILED"};
  }finally{client.release();}
 }

 return Object.freeze({append,getOperation,listOperations,listEvents,summarizeModules,checkReady,verifyChain});
}
