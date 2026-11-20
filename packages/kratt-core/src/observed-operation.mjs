import { randomUUID } from "node:crypto";
import { createOperationEvent } from "./runtime-observatory.mjs";

function timestamp(clock){
 const value=clock();
 const date=value instanceof Date?new Date(value.getTime()):new Date(value);
 if(!Number.isFinite(date.getTime()))throw new Error("OBSERVATORY_CLOCK_INVALID");
 return date.toISOString();
}
function safeRef(value){
 return value===null||typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)&&!value.includes("..")&&!value.includes("://");
}

export function createObservedOperationRunner({
 store,clock=()=>new Date(),makeEventId=()=>randomUUID(),
}={}){
 if(!store||typeof store.append!=="function")throw new TypeError("OBSERVATORY_EVENT_STORE_REQUIRED");
 if(typeof clock!=="function"||typeof makeEventId!=="function")throw new TypeError("OBSERVATORY_CLOCK_AND_ID_FACTORY_REQUIRED");

 async function run({
  operation_id,correlation_id,module_id,adapter_id=null,capability,capability_state,
  environment,runtime_version,input_ref=null,evidence_refs=[],execute,outputRef=()=>null,
 }={}){
  if(typeof execute!=="function"||typeof outputRef!=="function"||!safeRef(input_ref))
   return{status:"BLOCKED",reason:"OPERATION_INPUT_INVALID"};
  const metadata={operation_id,correlation_id,module_id,adapter_id,capability,capability_state,
   environment,runtime_version,input_ref,evidence_refs};
  const create=(status,occurredAt,startedAt,finishedAt,durationMs,output=null)=>{
   return createOperationEvent({
    schema_version:"kratt-runtime-operation/v1",event_id:makeEventId(),
    event_type:"operation."+status,...metadata,status,occurred_at:occurredAt,
    started_at:startedAt,finished_at:finishedAt,duration_ms:durationMs,
    output_ref:output,evidence_refs,
   });
  };
  async function append(event){
   try{
    const result=await store.append(event);
    return result?.ok===true;
   }catch{return false;}
  }
  let queuedAt;
  try{
   queuedAt=timestamp(clock);
   if(!await append(create("queued",queuedAt,null,null,null)))
    return{status:"BLOCKED",reason:"OBSERVABILITY_QUEUE_RECORD_FAILED"};
  }catch{
   return{status:"BLOCKED",reason:"OBSERVABILITY_QUEUE_RECORD_FAILED"};
  }
  let startedAt;
  try{
   startedAt=timestamp(clock);
   if(!await append(create("running",startedAt,startedAt,null,null))){
    try{const notRunAt=timestamp(clock);await append(create("not_run",notRunAt,null,notRunAt,null));}catch{}
    return{status:"BLOCKED",reason:"OBSERVABILITY_START_RECORD_FAILED"};
   }
  }catch{
   try{
    const at=timestamp(clock);
    await append(create("not_run",at,null,at,null));
   }catch{}
   return{status:"BLOCKED",reason:"OBSERVABILITY_START_RECORD_FAILED"};
  }
  let result,status="succeeded";
  try{
   result=await execute({operation_id,correlation_id});
  }catch(error){
   status=error?.name==="AbortError"?"cancelled":error?.name==="TimeoutError"?"timed_out":"failed";
  }
  let finishedAt,durationMs,output=null;
  try{
   finishedAt=timestamp(clock);
   durationMs=Date.parse(finishedAt)-Date.parse(startedAt);
   if(durationMs<0)throw new Error("OBSERVATORY_CLOCK_MOVED_BACKWARD");
   if(status==="succeeded"){
    output=outputRef(result);
    if(output===null||!safeRef(output))throw new Error("OBSERVATORY_OUTPUT_REFERENCE_INVALID");
   }
   const terminal=create(status,finishedAt,startedAt,finishedAt,durationMs,output);
   if(!await append(terminal))
    return{status:"OUTCOME_UNRECORDED",executed:true,operation_status:status};
  }catch{
   return{status:"OUTCOME_UNRECORDED",executed:true,operation_status:status};
  }
  if(status==="succeeded")return{status:"COMPLETED",operation_id,result};
  const outcome=status==="cancelled"?"CANCELLED":status==="timed_out"?"TIMED_OUT":"FAILED";
  return{status:outcome,operation_id,operation_status:status,reason:"OPERATION_EXECUTION_FAILED"};
 }
 return Object.freeze({run});
}
