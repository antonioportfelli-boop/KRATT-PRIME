import { createHash } from "node:crypto";
const SCHEMA="kratt-runtime-operation/v1";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const STATUSES=["queued","running","succeeded","failed","cancelled","timed_out","not_run"];
const TERMINAL=new Set(["succeeded","failed","cancelled","timed_out","not_run"]);
const CAPABILITIES=["bound","partial","mock","unbound","disabled"];
const EVIDENCE_KINDS=["log","test","artifact","commit","trace"];
const ENVIRONMENTS=["development","test","staging","production"];
const EVENT_KEYS=[
 "schema_version","event_id","event_type","operation_id","correlation_id","module_id","adapter_id",
 "capability","capability_state","status","occurred_at","started_at","finished_at","duration_ms",
 "input_ref","output_ref","evidence_refs","environment","runtime_version"
];
const META_KEYS=["operation_id","correlation_id","module_id","adapter_id","capability",
 "capability_state","input_ref","environment","runtime_version"];

function plain(value){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);
 return proto===Object.prototype||proto===null;
}
function iso(value){
 if(typeof value!=="string")return false;
 const parsed=new Date(value);
 return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value;
}
function ref(value){return value===null||typeof value==="string"&&REF.test(value)&&!value.includes("..")&&!value.includes("://");}
function fail(code){throw new TypeError(code);}
function stable(value){
 if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(Object.is(value,-0)?0:value);
 if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
 if(!plain(value))fail("OBSERVATORY_NON_CANONICAL_VALUE");
 const keys=Reflect.ownKeys(value);
 if(keys.some(key=>typeof key!=="string"))fail("OBSERVATORY_SYMBOL_KEY");
 return "{"+keys.sort().map(key=>{
  if(["__proto__","constructor","prototype"].includes(key))fail("OBSERVATORY_UNSAFE_KEY");
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!("value"in descriptor)||!descriptor.enumerable)fail("OBSERVATORY_ACCESSOR_REJECTED");
  return JSON.stringify(key)+":"+stable(descriptor.value);
 }).join(",")+"}";
}

export function stableOperationJson(value){return stable(value);}

export function createOperationEvent(input){
 if(!plain(input))fail("OBSERVATORY_EVENT_OBJECT_REQUIRED");
 const keys=Reflect.ownKeys(input);
 if(keys.some(key=>typeof key!=="string"||!EVENT_KEYS.includes(key)))fail("OBSERVATORY_EVENT_FIELD_NOT_ALLOWED");
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor||!("value"in descriptor)||!descriptor.enumerable)fail("OBSERVATORY_EVENT_ACCESSOR_REJECTED");}
 if(EVENT_KEYS.some(key=>!Object.hasOwn(input,key)))fail("OBSERVATORY_EVENT_FIELD_MISSING");
 if(input.schema_version!==SCHEMA)fail("OBSERVATORY_SCHEMA_VERSION_INVALID");
 if(!ID.test(input.event_id??"")||!ID.test(input.operation_id??"")||
  !ID.test(input.correlation_id??"")||!ID.test(input.module_id??"")||
  !(input.adapter_id===null||ID.test(input.adapter_id??""))||!ID.test(input.capability??""))
  fail("OBSERVATORY_ID_INVALID");
 if(!CAPABILITIES.includes(input.capability_state))fail("OBSERVATORY_CAPABILITY_STATE_INVALID");
 if(!STATUSES.includes(input.status)||input.event_type!=="operation."+input.status)
  fail("OBSERVATORY_STATUS_INVALID");
 if(!iso(input.occurred_at))fail("OBSERVATORY_OCCURRED_AT_INVALID");
 if(input.started_at!==null&&!iso(input.started_at))fail("OBSERVATORY_STARTED_AT_INVALID");
 if(input.finished_at!==null&&!iso(input.finished_at))fail("OBSERVATORY_FINISHED_AT_INVALID");
 if(input.duration_ms!==null&&(!Number.isSafeInteger(input.duration_ms)||input.duration_ms<0||input.duration_ms>7*24*60*60*1000))
  fail("OBSERVATORY_DURATION_INVALID");
 if(!ref(input.input_ref)||!ref(input.output_ref))fail("OBSERVATORY_REFERENCE_INVALID");
 if(!ENVIRONMENTS.includes(input.environment))fail("OBSERVATORY_ENVIRONMENT_INVALID");
 if(typeof input.runtime_version!=="string"||! /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(input.runtime_version))
  fail("OBSERVATORY_RUNTIME_VERSION_INVALID");
 if(!Array.isArray(input.evidence_refs)||input.evidence_refs.length>32)fail("OBSERVATORY_EVIDENCE_REFS_INVALID");
 const evidence_refs=input.evidence_refs.map(item=>{
  if(!plain(item)||Reflect.ownKeys(item).length!==3||
   !["kind","ref","digest"].every(key=>Object.hasOwn(item,key)))fail("OBSERVATORY_EVIDENCE_REF_INVALID");
  if(!EVIDENCE_KINDS.includes(item.kind)||!REF.test(item.ref??"")||item.ref.includes("..")||item.ref.includes("://")||
   !(item.digest===null||DIGEST.test(item.digest??"")))fail("OBSERVATORY_EVIDENCE_REF_INVALID");
  return Object.freeze({kind:item.kind,ref:item.ref,digest:item.digest});
 });
 if(input.status==="queued"){
  if(input.started_at!==null||input.finished_at!==null||input.duration_ms!==null)
   fail("OBSERVATORY_QUEUED_TIMING_INVALID");
 }else if(input.status==="running"){
  if(input.started_at!==input.occurred_at||input.finished_at!==null||input.duration_ms!==null)
   fail("OBSERVATORY_RUNNING_TIMING_INVALID");
 }else{
  if(input.finished_at!==input.occurred_at)fail("OBSERVATORY_TERMINAL_FINISH_TIME_INVALID");
  if(input.started_at===null&&input.duration_ms!==null)fail("OBSERVATORY_TERMINAL_DURATION_WITHOUT_START");
  if(input.started_at!==null){
   const expected=Date.parse(input.finished_at)-Date.parse(input.started_at);
   if(expected<0||input.duration_ms!==expected)fail("OBSERVATORY_TERMINAL_DURATION_MISMATCH");
  }else if(input.duration_ms!==null)fail("OBSERVATORY_TERMINAL_DURATION_INVALID");
 }
 const event={
  schema_version:SCHEMA,event_id:input.event_id,event_type:input.event_type,
  operation_id:input.operation_id,correlation_id:input.correlation_id,module_id:input.module_id,
  adapter_id:input.adapter_id,capability:input.capability,capability_state:input.capability_state,
  status:input.status,occurred_at:input.occurred_at,started_at:input.started_at,
  finished_at:input.finished_at,duration_ms:input.duration_ms,input_ref:input.input_ref,
  output_ref:input.output_ref,evidence_refs:Object.freeze(evidence_refs),
  environment:input.environment,runtime_version:input.runtime_version,
 };
 if(Buffer.byteLength(stable(event),"utf8")>32*1024)fail("OBSERVATORY_EVENT_TOO_LARGE");
 return Object.freeze(event);
}

export function validateOperationEvent(input){
 try{return{ok:true,value:createOperationEvent(input)};}
 catch(error){return{ok:false,reason:error instanceof TypeError?error.message:"OBSERVATORY_EVENT_INVALID"};}
}

export function validateOperationTransition(previous,eventInput){
 let event;
 try{event=createOperationEvent(eventInput);}catch(error){return{ok:false,reason:error.message};}
 if(!previous){
  if(event.status!=="queued"&&event.status!=="not_run")
   return{ok:false,reason:"OBSERVATORY_INITIAL_STATE_MUST_BE_QUEUED_OR_NOT_RUN"};
  return{ok:true,value:event};
 }
 if(!plain(previous)||TERMINAL.has(previous.status))
  return{ok:false,reason:"OBSERVATORY_OPERATION_ALREADY_TERMINAL"};
 if(!STATUSES.includes(previous.status))return{ok:false,reason:"OBSERVATORY_PREVIOUS_STATUS_INVALID"};
 for(const key of META_KEYS)if(previous[key]!==event[key])
  return{ok:false,reason:"OBSERVATORY_OPERATION_METADATA_CHANGED"};
 const previousTime=previous.last_occurred_at??previous.occurred_at;
 if(!iso(previousTime)||Date.parse(event.occurred_at)<Date.parse(previousTime))
  return{ok:false,reason:"OBSERVATORY_EVENT_TIME_MOVED_BACKWARD"};
 const allowed=previous.status==="queued"
  ?["running","cancelled","not_run"]
  :previous.status==="running"
   ?["succeeded","failed","cancelled","timed_out"]
   :[];
 if(!allowed.includes(event.status))return{ok:false,reason:"OBSERVATORY_INVALID_STATUS_TRANSITION"};
 const expectedStart=previous.started_at??(event.status==="running"?event.occurred_at:null);
 if(event.started_at!==expectedStart)return{ok:false,reason:"OBSERVATORY_START_TIME_CHANGED"};
 if(TERMINAL.has(event.status)){
  const expectedDuration=expectedStart===null?null:Date.parse(event.occurred_at)-Date.parse(expectedStart);
  if(event.finished_at!==event.occurred_at||event.duration_ms!==expectedDuration)
   return{ok:false,reason:"OBSERVATORY_FINISH_TIME_INVALID"};
 }
 return{ok:true,value:event};
}

export function projectOperation(eventInput,sequence,previous=null){
 const event=createOperationEvent(eventInput);
 if(!Number.isSafeInteger(sequence)||sequence<1)fail("OBSERVATORY_SEQUENCE_INVALID");
 return Object.freeze({
  operation_id:event.operation_id,correlation_id:event.correlation_id,module_id:event.module_id,
  adapter_id:event.adapter_id,capability:event.capability,capability_state:event.capability_state,
  status:event.status,queued_at:previous?.queued_at??event.occurred_at,
  started_at:event.started_at,finished_at:event.finished_at,duration_ms:event.duration_ms,
  input_ref:event.input_ref,output_ref:event.output_ref,evidence_refs:event.evidence_refs,
  environment:event.environment,runtime_version:event.runtime_version,
  last_occurred_at:event.occurred_at,last_event_id:event.event_id,last_sequence:sequence,
 });
}

export function runtimeOperationHash(sequence,previousHash,eventInput){
 if(!Number.isSafeInteger(sequence)||sequence<1||! /^[a-f0-9]{64}$/.test(previousHash??""))
  fail("OBSERVATORY_HASH_INPUT_INVALID");
 const event=createOperationEvent(eventInput);
 return createHash("sha256").update(String(sequence)+"\n"+previousHash+"\n"+stable(event),"utf8").digest("hex");
}

export function summarizeModules(operations){
 if(!Array.isArray(operations))fail("OBSERVATORY_OPERATIONS_ARRAY_REQUIRED");
 const grouped=new Map();
 for(const operation of operations){
  if(!plain(operation)||!ID.test(operation.module_id??"")||!STATUSES.includes(operation.status))continue;
  const entry=grouped.get(operation.module_id)??{
   module_id:operation.module_id,total:0,status_counts:Object.fromEntries(STATUSES.map(s=>[s,0])),
   capability_states:new Set(),last_operation_at:null,successful_durations:[]
  };
  entry.total++;entry.status_counts[operation.status]++;
  if(CAPABILITIES.includes(operation.capability_state))entry.capability_states.add(operation.capability_state);
  const last=operation.last_occurred_at??operation.updated_at??null;
  if(iso(last)&&(!entry.last_operation_at||Date.parse(last)>Date.parse(entry.last_operation_at)))entry.last_operation_at=last;
  if(operation.status==="succeeded"&&Number.isSafeInteger(operation.duration_ms)&&operation.duration_ms>=0)
   entry.successful_durations.push(operation.duration_ms);
  grouped.set(operation.module_id,entry);
 }
 return [...grouped.values()].sort((a,b)=>a.module_id.localeCompare(b.module_id)).map(entry=>{
  const durations=entry.successful_durations;
  return Object.freeze({
   module_id:entry.module_id,total:entry.total,status_counts:Object.freeze(entry.status_counts),
   capability_states:Object.freeze([...entry.capability_states].sort()),
   last_operation_at:entry.last_operation_at,
   average_success_duration_ms:durations.length?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length):null,
  });
 });
}
