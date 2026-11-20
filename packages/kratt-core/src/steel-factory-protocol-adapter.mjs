import { createHash } from "node:crypto";
import { EVIDENCE_CLAIMS, KRATT_SCHEMA_VERSION } from "./contracts.mjs";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TASK_ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENT_ID=/^(FORGE|SERPENT|CITADEL)-\d{3}$/;
const SHA1=/^[0-9a-f]{40}$/;
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const ACTION=/^[a-z][a-z0-9:_-]{0,63}$/;
const PATH=/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const plain=v=>!!v&&typeof v==="object"&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const digest=v=>createHash("sha256").update(v,"utf8").digest("hex");
const stable=v=>{
 if(v===null||typeof v!=="object")return JSON.stringify(v);
 if(Array.isArray(v))return "["+v.map(stable).join(",")+"]";
 return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+stable(v[k])).join(",")+"}";
};
const same=(a,b)=>stable(a)===stable(b);
const validText=(v,max)=>typeof v==="string"&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const uniqueStrings=(v,re,min,max)=>Array.isArray(v)&&v.length>=min&&v.length<=max&&v.every(x=>typeof x==="string"&&re.test(x))&&new Set(v).size===v.length;
const validUtc=v=>{
 if(typeof v!=="string")return false;
 const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(v);
 if(!m)return false;
 const t=Date.parse(v);
 return Number.isFinite(t)&&new Date(t).toISOString()===m[1]+"."+(m[2]??"").padEnd(3,"0")+"Z";
};
const OBJECTIVE_SPOOFING=/[\u0080-\u009f\u00ad\u034f\u061c\u180e\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u206a-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ud800-\udfff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

function snapshotJson(value,state={active:new WeakSet(),nodes:0},depth=0){
 if(value===null||typeof value==="string"||typeof value==="boolean")return value;
 if(typeof value==="number"&&Number.isFinite(value))return Object.is(value,-0)?0:value;
 if(typeof value!=="object"||depth>24)throw new TypeError("STEEL_JSON_VALUE_INVALID");
 state.nodes++;
 if(state.nodes>8192||state.active.has(value))throw new TypeError("STEEL_JSON_COMPLEXITY_INVALID");
 state.active.add(value);
 let result;
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError("STEEL_JSON_ARRAY_INVALID");
  const keys=Reflect.ownKeys(value);
  if(keys.length!==value.length+1||!keys.includes("length")||
   keys.some(key=>typeof key!=="string"&&key!=="length"||
    typeof key==="string"&&key!=="length"&&!/^(?:0|[1-9][0-9]*)$/.test(key)))
   throw new TypeError("STEEL_JSON_ARRAY_SHAPE_INVALID");
  result=[];
  for(let i=0;i<value.length;i++){
   const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
   if(!descriptor||!("value"in descriptor)||!descriptor.enumerable)
    throw new TypeError("STEEL_JSON_ARRAY_ACCESSOR_REJECTED");
   result.push(snapshotJson(descriptor.value,state,depth+1));
  }
 }else{
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)throw new TypeError("STEEL_JSON_OBJECT_INVALID");
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=="string"))throw new TypeError("STEEL_JSON_SYMBOL_KEY_REJECTED");
  result=Object.create(null);
  for(const key of keys){
   if(["__proto__","constructor","prototype"].includes(key))throw new TypeError("STEEL_JSON_UNSAFE_KEY_REJECTED");
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor||!("value"in descriptor)||!descriptor.enumerable)
    throw new TypeError("STEEL_JSON_ACCESSOR_REJECTED");
   Object.defineProperty(result,key,{
    value:snapshotJson(descriptor.value,state,depth+1),enumerable:true,writable:false,configurable:false,
   });
  }
 }
 state.active.delete(value);
 return Object.freeze(result);
}

function validBranch(branch){
 if(!BRANCH.test(branch)||branch.endsWith("/")||branch.endsWith(".")||branch.includes(".."))return false;
 return branch.split("/").every(part=>part!==""&&!part.startsWith(".")&&!part.endsWith(".lock"));
}

function validateEnvelope(input){
 let v;
 try{v=snapshotJson(input);}catch{return{ok:false,reason:"STEEL_TASK_ENVELOPE_INVALID"};}
 if(!plain(v)||Reflect.ownKeys(v).length!==13||
  !["task_id","factory","agent_id","objective","repository","branch","base_sha","scope",
   "allowed_actions","forbidden_actions","required_evidence","resource_budget","protocol_version"].every(k=>Object.hasOwn(v,k))||
  v.protocol_version!==1||!TASK_ID.test(v.task_id??"")||
  !["FORGE","SERPENT","CITADEL"].includes(v.factory)||!AGENT_ID.test(v.agent_id??"")||
  !v.agent_id.startsWith(v.factory+"-")||!validText(v.objective,500)||OBJECTIVE_SPOOFING.test(v.objective??"")||
  !REPO.test(v.repository??"")||v.repository.split("/").some(s=>s==="."||s==="..")||
  !validBranch(v.branch??"")||!SHA1.test(v.base_sha??"")||!uniqueStrings(v.scope,PATH,1,64)||
  !uniqueStrings(v.allowed_actions,ACTION,1,16)||!uniqueStrings(v.forbidden_actions,ACTION,0,32)||
  v.allowed_actions.some(a=>v.forbidden_actions.includes(a))||!uniqueStrings(v.required_evidence,ACTION,1,16)||
  !plain(v.resource_budget)||Reflect.ownKeys(v.resource_budget).length!==3||
  !["max_wall_ms","max_output_bytes","max_files"].every(k=>Object.hasOwn(v.resource_budget,k))||
  !Number.isInteger(v.resource_budget.max_wall_ms)||v.resource_budget.max_wall_ms<100||v.resource_budget.max_wall_ms>600000||
  !Number.isInteger(v.resource_budget.max_output_bytes)||v.resource_budget.max_output_bytes<1024||v.resource_budget.max_output_bytes>1048576||
  !Number.isInteger(v.resource_budget.max_files)||v.resource_budget.max_files<1||v.resource_budget.max_files>64||
  v.scope.length>v.resource_budget.max_files)
  return{ok:false,reason:"STEEL_TASK_ENVELOPE_INVALID"};
 if(Buffer.byteLength(JSON.stringify(v),"utf8")>262144)return{ok:false,reason:"STEEL_TASK_ENVELOPE_TOO_LARGE"};
 return{ok:true,value:v};
}

function validateReceipt(input){
 let v;
 try{v=snapshotJson(input);}catch{return{ok:false,reason:"STEEL_ACTION_RECEIPT_INVALID"};}
 if(!plain(v)||Reflect.ownKeys(v).length!==11||
  !["task_id","agent_id","repository","base_sha","action","scope","result","evidence",
   "verification_state","timestamp","protocol_version"].every(k=>Object.hasOwn(v,k))||
  v.protocol_version!==1||!TASK_ID.test(v.task_id??"")||
  !AGENT_ID.test(v.agent_id??"")||!REPO.test(v.repository??"")||
  v.repository.split("/").some(s=>s==="."||s==="..")||!SHA1.test(v.base_sha??"")||
  !ACTION.test(v.action??"")||!uniqueStrings(v.scope,PATH,1,64)||
  !plain(v.result)||Reflect.ownKeys(v.result).length!==4||
  !["ok","exit_code","checks","failure"].every(k=>Object.hasOwn(v.result,k))||
  typeof v.result.ok!=="boolean"||!Number.isInteger(v.result.exit_code)||v.result.exit_code< -1||v.result.exit_code>255||
  !plain(v.result.checks)||Reflect.ownKeys(v.result.checks).length!==2||
  !Number.isInteger(v.result.checks.pass)||v.result.checks.pass<0||v.result.checks.pass>1000000||
  !Number.isInteger(v.result.checks.fail)||v.result.checks.fail<0||v.result.checks.fail>1000000||
  !(v.result.failure===null||validText(v.result.failure,300))||!plain(v.evidence)||
  !["UNVERIFIED","VERIFIED","REJECTED","INSUFFICIENT_EVIDENCE"].includes(v.verification_state)||
  !validUtc(v.timestamp))
  return{ok:false,reason:"STEEL_ACTION_RECEIPT_INVALID"};
 if(Buffer.byteLength(JSON.stringify(v),"utf8")>262144)return{ok:false,reason:"STEEL_ACTION_RECEIPT_TOO_LARGE"};
 return{ok:true,value:v};
}

/** Closed-schema adapter for STEEL factory/protocol v1. */
export function createSteelFactoryProtocolAdapter({verifyActionReceipt,evidenceClaimMap={}}={}){
 if(typeof verifyActionReceipt!=="function")throw new TypeError("STEEL_RECEIPT_VERIFIER_REQUIRED");
 let safeClaimMap;
 try{safeClaimMap=snapshotJson(evidenceClaimMap);}catch{throw new TypeError("STEEL_EVIDENCE_CLAIM_MAP_INVALID");}
 if(!plain(safeClaimMap))throw new TypeError("STEEL_EVIDENCE_CLAIM_MAP_INVALID");
 for(const [token,claim] of Object.entries(safeClaimMap))
  if(!ACTION.test(token)||!EVIDENCE_CLAIMS.includes(claim))throw new TypeError("STEEL_EVIDENCE_CLAIM_MAP_INVALID");

 function adaptTask(input={}){
  let args;
  try{args=snapshotJson(input);}catch{return{ok:false,reason:"STEEL_TASK_INPUT_INVALID"};}
  if(!plain(args))return{ok:false,reason:"STEEL_TASK_INPUT_INVALID"};
  const e=validateEnvelope(args.envelope);if(!e.ok)return e;
  const action=args.action,scope=args.scope,actor=args.actor;
  const provider=args.provider===undefined?"github":args.provider;
  const createdAt=args.createdAt===undefined?new Date().toISOString():args.createdAt;
  if(actor!==e.value.agent_id||!ID.test(actor??"")||!ACTION.test(action??"")||!e.value.allowed_actions.includes(action)||
   e.value.forbidden_actions.includes(action)||!uniqueStrings(scope,PATH,1,64)||scope.some(p=>!e.value.scope.includes(p))||
   !ID.test(provider??"")||!validUtc(createdAt))
   return{ok:false,reason:"STEEL_TASK_SCOPE_OR_ACTOR_MISMATCH"};
  const claims=e.value.required_evidence.map(token=>safeClaimMap[token]);
  if(claims.some(claim=>!claim))return{ok:false,reason:"STEEL_EVIDENCE_CLAIM_MAPPING_REQUIRED"};
  const resourceId="repo-"+digest(e.value.repository).slice(0,32);
  const task={
   schema_version:KRATT_SCHEMA_VERSION,task_id:e.value.task_id,actor,action,
   target:{resource_type:"repository",resource_id:resourceId},
   constraints:{provider,repository:e.value.repository,branch:e.value.branch,base_sha:e.value.base_sha,factory:e.value.factory,
    protocol_version:e.value.protocol_version,scope_digest:digest(JSON.stringify([...scope].sort()))},
   required_evidence:claims.map(claim_type=>({claim_type,subject:resourceId,required:true,revision:null})),
   created_at:createdAt,requested_authority:[],status:"PENDING",
  };
  return{ok:true,task,protocol_binding:Object.freeze({protocol_version:1,task_id:e.value.task_id,repository:e.value.repository,
   branch:e.value.branch,base_sha:e.value.base_sha,agent_id:e.value.agent_id,factory:e.value.factory,scope:Object.freeze([...scope]),resource_id:resourceId})};
 }

 async function verifyReceipt(input={}){
  let args;
  try{args=snapshotJson(input);}catch{return{ok:false,reason:"STEEL_PROTOCOL_INPUT_INVALID"};}
  if(!plain(args))return{ok:false,reason:"STEEL_PROTOCOL_INPUT_INVALID"};
  const e=validateEnvelope(args.envelope),r=validateReceipt(args.receipt);
  let expectedScope;
  try{expectedScope=snapshotJson(args.expectedScope);}catch{return{ok:false,reason:"STEEL_PROTOCOL_INPUT_INVALID"};}
  if(!e.ok||!r.ok||!uniqueStrings(expectedScope,PATH,1,64))
   return{ok:false,reason:"STEEL_PROTOCOL_INPUT_INVALID"};
  const t=e.value,p=r.value,expectedAction=args.expectedAction;
  if(p.task_id!==t.task_id||p.agent_id!==t.agent_id||p.repository!==t.repository||p.base_sha!==t.base_sha||
   p.action!==expectedAction||!t.allowed_actions.includes(p.action)||t.forbidden_actions.includes(p.action)||
   !same(p.scope,expectedScope)||p.scope.some(path=>!t.scope.includes(path))||
   p.verification_state!=="VERIFIED"||p.result.ok!==true||p.result.exit_code!==0||p.result.checks.fail!==0)
   return{ok:false,reason:"STEEL_RECEIPT_BINDING_MISMATCH"};
  let trusted=false;try{trusted=await verifyActionReceipt(p,t)===true;}catch{trusted=false;}
  if(!trusted)return{ok:false,reason:"STEEL_RECEIPT_NOT_INDEPENDENTLY_VERIFIED"};
  return{ok:true,receipt_digest:"sha256:"+digest(stable(p)),task_id:p.task_id,action:p.action,
   repository:p.repository,base_sha:p.base_sha,verified_checks:p.result.checks.pass};
 }
 return Object.freeze({adaptTask,verifyReceipt});
}
