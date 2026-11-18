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
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{
 const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&"value"in d&&!d.get&&!d.set;
});
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
};;
const TASK_KEYS=["task_id","factory","agent_id","objective","repository","branch","base_sha","scope","allowed_actions","forbidden_actions","required_evidence","resource_budget","protocol_version"];
const RECEIPT_KEYS=["task_id","agent_id","repository","base_sha","action","scope","result","evidence","verification_state","timestamp","protocol_version"];
function validateEnvelope(v){
 if(!exact(v,TASK_KEYS)||v.protocol_version!==1||!TASK_ID.test(v.task_id??"")||
  !["FORGE","SERPENT","CITADEL"].includes(v.factory)||!AGENT_ID.test(v.agent_id??"")||
  !v.agent_id.startsWith(v.factory+"-")||!validText(v.objective,500)||!REPO.test(v.repository??"")||
  !BRANCH.test(v.branch??"")||!SHA1.test(v.base_sha??"")||!uniqueStrings(v.scope,PATH,1,64)||
  !uniqueStrings(v.allowed_actions,ACTION,1,16)||!uniqueStrings(v.forbidden_actions,ACTION,0,32)||
  v.allowed_actions.some(a=>v.forbidden_actions.includes(a))||!uniqueStrings(v.required_evidence,ACTION,1,16)||
  !exact(v.resource_budget,["max_wall_ms","max_output_bytes","max_files"])||
  !Number.isInteger(v.resource_budget.max_wall_ms)||v.resource_budget.max_wall_ms<100||v.resource_budget.max_wall_ms>600000||
  !Number.isInteger(v.resource_budget.max_output_bytes)||v.resource_budget.max_output_bytes<1024||v.resource_budget.max_output_bytes>1048576||
  !Number.isInteger(v.resource_budget.max_files)||v.resource_budget.max_files<1||v.resource_budget.max_files>64||
  v.scope.length>v.resource_budget.max_files||v.repository.split("/").some(s=>s==="."||s==="..")||
  v.branch.endsWith("/")||v.branch.endsWith(".")||v.branch.includes("..")||v.branch.split("/").some(s=>!s||s.startsWith(".")||s.endsWith(".lock")))
  return{ok:false,reason:"STEEL_TASK_ENVELOPE_INVALID"};
 return{ok:true,value:structuredClone(v)};
}
function validateReceipt(v){
 if(!exact(v,RECEIPT_KEYS)||v.protocol_version!==1||!TASK_ID.test(v.task_id??"")||
  !AGENT_ID.test(v.agent_id??"")||!REPO.test(v.repository??"")||!SHA1.test(v.base_sha??"")||
  !ACTION.test(v.action??"")||!uniqueStrings(v.scope,PATH,1,64)||
  !exact(v.result,["ok","exit_code","checks","failure"])||typeof v.result.ok!=="boolean"||
  !Number.isInteger(v.result.exit_code)||v.result.exit_code< -1||v.result.exit_code>255||
  !exact(v.result.checks,["pass","fail"])||!Number.isInteger(v.result.checks.pass)||v.result.checks.pass<0||
  !Number.isInteger(v.result.checks.fail)||v.result.checks.fail<0||
  !(v.result.failure===null||validText(v.result.failure,300))||!plain(v.evidence)||
  !["UNVERIFIED","VERIFIED","REJECTED","INSUFFICIENT_EVIDENCE"].includes(v.verification_state)||
  !validUtc(v.timestamp))
  return{ok:false,reason:"STEEL_ACTION_RECEIPT_INVALID"};
 return{ok:true,value:structuredClone(v)};
}

/** Closed-schema adapter for STEEL factory/protocol v1. */
export function createSteelFactoryProtocolAdapter({verifyActionReceipt,evidenceClaimMap={}}={}){
 if(typeof verifyActionReceipt!=="function")throw new TypeError("STEEL_RECEIPT_VERIFIER_REQUIRED");
 if(!plain(evidenceClaimMap))throw new TypeError("STEEL_EVIDENCE_CLAIM_MAP_INVALID");
 for(const [token,claim] of Object.entries(evidenceClaimMap))
  if(!ACTION.test(token)||!EVIDENCE_CLAIMS.includes(claim))throw new TypeError("STEEL_EVIDENCE_CLAIM_MAP_INVALID");

 function adaptTask({envelope,action,scope,actor,provider="github",createdAt=new Date().toISOString()}={}){
  const checked=validateEnvelope(envelope);if(!checked.ok)return checked;const e=checked.value;
  if(actor!==e.agent_id||!ID.test(actor??"")||!ACTION.test(action??"")||!e.allowed_actions.includes(action)||
   e.forbidden_actions.includes(action)||!uniqueStrings(scope,PATH,1,64)||scope.some(p=>!e.scope.includes(p))||
   !ID.test(provider??"")||!validUtc(createdAt))return{ok:false,reason:"STEEL_TASK_SCOPE_OR_ACTOR_MISMATCH"};
  const claims=e.required_evidence.map(token=>evidenceClaimMap[token]);
  if(claims.some(claim=>!claim))return{ok:false,reason:"STEEL_EVIDENCE_CLAIM_MAPPING_REQUIRED"};
  const resourceId="repo-"+digest(e.repository).slice(0,32);
  const task={
   schema_version:KRATT_SCHEMA_VERSION,task_id:e.task_id,actor,action,
   target:{resource_type:"repository",resource_id:resourceId},
   constraints:{provider,repository:e.repository,branch:e.branch,base_sha:e.base_sha,factory:e.factory,
    protocol_version:e.protocol_version,scope_digest:digest(JSON.stringify([...scope].sort()))},
   required_evidence:claims.map(claim_type=>({claim_type,subject:resourceId,required:true,revision:null})),
   created_at:createdAt,requested_authority:[],status:"PENDING",
  };
  return{ok:true,task,protocol_binding:Object.freeze({protocol_version:1,task_id:e.task_id,repository:e.repository,
   branch:e.branch,base_sha:e.base_sha,agent_id:e.agent_id,factory:e.factory,scope:Object.freeze([...scope]),resource_id:resourceId})};
 }
 async function verifyReceipt({envelope,receipt,expectedAction,expectedScope}={}){
  const e=validateEnvelope(envelope),r=validateReceipt(receipt);if(!e.ok||!r.ok)return{ok:false,reason:"STEEL_PROTOCOL_INPUT_INVALID"};
  const t=e.value,p=r.value;
  if(p.task_id!==t.task_id||p.agent_id!==t.agent_id||p.repository!==t.repository||p.base_sha!==t.base_sha||
   p.action!==expectedAction||!t.allowed_actions.includes(p.action)||t.forbidden_actions.includes(p.action)||
   !same(p.scope,expectedScope)||p.scope.some(path=>!t.scope.includes(path))||p.verification_state!=="VERIFIED"||
   p.result.ok!==true||p.result.exit_code!==0||p.result.checks.fail!==0)
   return{ok:false,reason:"STEEL_RECEIPT_BINDING_MISMATCH"};
  let trusted=false;try{trusted=await verifyActionReceipt(p,t)===true;}catch{trusted=false;}
  if(!trusted)return{ok:false,reason:"STEEL_RECEIPT_NOT_INDEPENDENTLY_VERIFIED"};
  return{ok:true,receipt_digest:"sha256:"+digest(stable(p)),task_id:p.task_id,action:p.action,
   repository:p.repository,base_sha:p.base_sha,verified_checks:p.result.checks.pass};
 }
 return Object.freeze({adaptTask,verifyReceipt});
}
