import { createHash, randomUUID } from "node:crypto";
import { canonicalTaskDigest } from "./policy.mjs";
import { validateTaskEnvelope } from "./contracts.mjs";
const SCHEMA="kratt-audit/v1", ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/, HEX=/^[a-f0-9]{64}$/, ZERO="0".repeat(64);
const digest=v=>createHash("sha256").update(v,"utf8").digest("hex");
const validId=v=>typeof v==="string"&&ID.test(v);
const validIdempotencyKey=v=>typeof v==="string"&&/^kratt:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}:[a-f0-9]{64}$/.test(v);
const validTime=v=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v);
function stable(v){
 if(v===null||typeof v==="string"||typeof v==="boolean")return JSON.stringify(v);
 if(typeof v==="number"&&Number.isFinite(v))return JSON.stringify(v);
 if(Array.isArray(v))return "["+v.map(stable).join(",")+"]";
 if(!v||typeof v!=="object"||Object.getPrototypeOf(v)!==Object.prototype)throw new TypeError("AUDIT_RECORD_NOT_JSON");
 const keys=Object.keys(v).sort();if(keys.length>128||keys.some(k=>["__proto__","constructor","prototype"].includes(k)))throw new TypeError("AUDIT_RECORD_KEYS_INVALID");
 return "{"+keys.map(k=>JSON.stringify(k)+":"+stable(v[k])).join(",")+"}";
}
const auditHash=(n,p,j)=>digest(String(n)+"\n"+p+"\n"+j);
async function tx(pool,work){const c=await pool.connect();try{await c.query("BEGIN");const r=await work(c);if(r===false||(r&&r.ok===false)){await c.query("ROLLBACK");return r;}await c.query("COMMIT");return r;}catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}finally{c.release();}}
export function createPostgresOutboxStore(pool,{clock=()=>new Date()}={}){
 if(!pool||typeof pool.connect!=="function")throw new TypeError("POSTGRES_POOL_REQUIRED");
 if(typeof clock!=="function")throw new TypeError("TRUSTED_CLOCK_REQUIRED");
 async function appendAudit(c,record){
  const json=stable(record);if(Buffer.byteLength(json,"utf8")>32768)throw new TypeError("AUDIT_RECORD_TOO_LARGE");
  const h=await c.query("SELECT sequence,hash FROM kratt_audit_head WHERE singleton=TRUE FOR UPDATE");
  const sequence=Number(h.rows[0]?.sequence??0)+1,previous=h.rows[0]?.hash??ZERO,hash=auditHash(sequence,previous,json);
  await c.query("INSERT INTO kratt_audit_events(sequence,event_id,event_type,created_at,record_json,previous_hash,hash) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",[sequence,record.event_id,record.event_type,record.created_at,json,previous,hash]);
  await c.query("UPDATE kratt_audit_head SET sequence=$1,hash=$2 WHERE singleton=TRUE",[sequence,hash]);return{sequence,hash};
 }
 async function reserveAuthorizedIntent({task,principal,approval,idempotencyKey,providerPayload}={}){
  const now=clock(),at=(now instanceof Date?now:new Date(now)).toISOString();
  const validatedTask=validateTaskEnvelope(task);
  if(!validatedTask.ok||!principal||!validId(principal.id)||validatedTask.value.actor!==principal.id)
   return{ok:false,reason:"RESERVATION_INPUT_INVALID"};
  task=validatedTask.value;
  const taskDigest=canonicalTaskDigest(task);
  const expectedKey=typeof taskDigest==="string"?"kratt:"+task.task_id+":"+taskDigest.slice(7):null;
  const hasApproval=approval!==null&&approval!==undefined;
  if(!validId(task.constraints?.provider)||!validIdempotencyKey(idempotencyKey)||idempotencyKey!==expectedKey||
   (hasApproval&&(!validId(approval?.key_id)||!validId(approval?.nonce)||!validId(approval?.approval_id)||
    !validTime(approval?.expires_at)||Date.parse(approval.expires_at)<=Date.parse(at)||
    !/^sha256:[a-f0-9]{64}$/.test(approval?.request_digest??"")||approval.request_digest!==taskDigest||!HEX.test(approval?.signature_digest??""))))
   return{ok:false,reason:"RESERVATION_INPUT_INVALID"};
  const intentId="intent:"+digest(idempotencyKey),outboxId="outbox:"+digest(idempotencyKey);
  const event={schema_version:SCHEMA,event_id:intentId,event_type:"dispatch.intent_committed",created_at:at,actor_id:principal.id,task_id:task.task_id,
   provider:task.constraints.provider,operation:task.action,idempotency_key:idempotencyKey,
   ...(hasApproval?{approval_key_id:approval.key_id,approval_id:approval.approval_id,request_digest:approval.request_digest}: {})};
  try{return await tx(pool,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[task.task_id]);
   if(hasApproval){
    const nonce=await c.query("INSERT INTO kratt_approval_nonces(key_id,nonce,approval_id,expires_at,consumed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key_id,nonce) DO NOTHING RETURNING key_id",
     [approval.key_id,approval.nonce,approval.approval_id,approval.expires_at,at]);
    if(nonce.rowCount!==1)return{ok:false,reason:"APPROVAL_REPLAYED"};
   }
   const cancelled=await c.query("SELECT task_id FROM kratt_cancelled_tasks WHERE task_id=$1 FOR UPDATE",[task.task_id]);
   if(cancelled.rowCount)return{ok:false,reason:"TASK_CANCELLED"};
   const intent=await c.query("INSERT INTO kratt_dispatch_intents(idempotency_key,task_id,actor_id,provider,operation,status,created_at) VALUES($1,$2,$3,$4,$5,'INTENT_COMMITTED',$6) ON CONFLICT(idempotency_key) DO NOTHING RETURNING idempotency_key",
    [idempotencyKey,task.task_id,principal.id,event.provider,task.action,at]);
   if(intent.rowCount!==1)return{ok:false,reason:"DUPLICATE_IDEMPOTENCY_KEY"};
   await c.query("INSERT INTO kratt_dispatch_outbox(outbox_id,idempotency_key,provider,payload,status,available_at) VALUES($1,$2,$3,$4::jsonb,'PENDING',$5)",
    [outboxId,idempotencyKey,event.provider,JSON.stringify(providerPayload??{task}),at]);
   const audit=await appendAudit(c,event);return{ok:true,intent_id:intentId,outbox_id:outboxId,audit_sequence:audit.sequence};
  });}catch(e){if(e?.code==="23505")return{ok:false,reason:"DUPLICATE_OR_REPLAYED"};throw e;}
 }
 async function appendDecision(record){
  if(!record||record.schema_version!==SCHEMA||record.event_type!=="authorization.denied"||
   !validId(record.event_id)||!validTime(record.created_at)||!validId(record.actor_id)||!validId(record.task_id)||
   typeof record.reason!=="string"||record.reason.length>160||!["DENY","BLOCKED","INSUFFICIENT_EVIDENCE"].includes(record.decision))return false;
  try{return await tx(pool,async c=>{await appendAudit(c,record);return true;});}catch{return false;}
 }
 async function verifyAuditChain(){
  const client=await pool.connect();
  let transaction=false;
  try{
   await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");transaction=true;
   const result=await client.query("SELECT sequence,event_id,event_type,created_at,record_json,previous_hash,hash FROM kratt_audit_events ORDER BY sequence");
   const head=await client.query("SELECT sequence,hash FROM kratt_audit_head WHERE singleton=TRUE");
   await client.query("COMMIT");transaction=false;
   let previous=ZERO,expected=1;
   for(const row of result.rows){
    const sequence=Number(row.sequence);
    let record;
    try{record=typeof row.record_json==="string"?JSON.parse(row.record_json):row.record_json;}catch{
     return{ok:false,count:result.rows.length,broken_sequence:sequence};
    }
    const createdAt=row.created_at instanceof Date?row.created_at.toISOString():new Date(row.created_at).toISOString();
    const json=stable(record);
    if(sequence!==expected||row.previous_hash!==previous||auditHash(sequence,previous,json)!==String(row.hash).trim()||
     record.event_id!==row.event_id||record.event_type!==row.event_type||record.created_at!==createdAt)
     return{ok:false,count:result.rows.length,broken_sequence:sequence};
    previous=String(row.hash).trim();expected++;
   }
   const latest=head.rows[0];
   if(!latest||Number(latest.sequence)!==result.rows.length||String(latest.hash).trim()!==previous)
    return{ok:false,count:result.rows.length,broken_sequence:result.rows.length+1};
   return{ok:true,count:result.rows.length,head_hash:previous};
  }catch{
   if(transaction){try{await client.query("ROLLBACK");}catch{}}
   return{ok:false,reason:"AUDIT_CHAIN_READ_FAILED"};
  }finally{client.release();}
 }
 async function claimOutbox({workerId,limit=10,leaseSeconds=60}={}){
  if(!validId(workerId)||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>900)throw new TypeError("OUTBOX_CLAIM_OPTIONS_INVALID");
  const token=randomUUID(),at=clock().toISOString(),until=new Date(Date.parse(at)+leaseSeconds*1000).toISOString();
  const r=await pool.query("WITH picked AS (SELECT outbox_id FROM kratt_dispatch_outbox WHERE ((status='PENDING' AND available_at<=$1) OR (status='LEASED' AND lease_until<=$1)) ORDER BY available_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE kratt_dispatch_outbox o SET status='LEASED',lease_owner=$3,lease_token=$4,lease_until=$5,attempts=o.attempts+1,updated_at=$1 FROM picked WHERE o.outbox_id=picked.outbox_id RETURNING o.outbox_id,o.idempotency_key,o.provider,o.payload,o.attempts,o.lease_token",
   [at,limit,workerId,token,until]);return r.rows;
 }
 async function finishOutbox({outboxId,leaseToken,outcome,actorId,taskId}={}){
  if(!validId(outboxId)||typeof leaseToken!=="string"||!validId(actorId)||!validId(taskId)||!["COMPLETED","FAILED"].includes(outcome?.status))return{ok:false,reason:"OUTBOX_FINISH_INPUT_INVALID"};
  const at=clock().toISOString();return tx(pool,async c=>{
   const q=await c.query("SELECT idempotency_key,provider,attempts FROM kratt_dispatch_outbox WHERE outbox_id=$1 AND status='LEASED' AND lease_token=$2 FOR UPDATE",[outboxId,leaseToken]);
   if(q.rowCount!==1)return{ok:false,reason:"LEASE_LOST"};const item=q.rows[0];
   const event={schema_version:SCHEMA,event_id:"outcome:"+digest(item.idempotency_key),event_type:outcome.status==="COMPLETED"?"dispatch.completed":"dispatch.failed",
    created_at:at,actor_id:actorId,task_id:taskId,provider:item.provider,idempotency_key:item.idempotency_key,result:{status:outcome.status.toLowerCase()}};
   await appendAudit(c,event);
   const iu=await c.query("UPDATE kratt_dispatch_intents SET status=$1,updated_at=$2 WHERE idempotency_key=$3 AND status='INTENT_COMMITTED' RETURNING idempotency_key",[outcome.status,at,item.idempotency_key]);
   if(iu.rowCount!==1)throw new Error("INTENT_STATE_CONFLICT");
   const ou=await c.query("UPDATE kratt_dispatch_outbox SET status='DONE',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE outbox_id=$2 AND status='LEASED' AND lease_token=$3 RETURNING outbox_id",[at,outboxId,leaseToken]);
   if(ou.rowCount!==1)throw new Error("OUTBOX_LEASE_CONFLICT");
   return{ok:true};
  });
 }
 async function retryOutbox({outboxId,leaseToken,errorCode,maxAttempts=8}={}){
  if(!validId(outboxId)||typeof leaseToken!=="string"||!/^[A-Z0-9_:-]{1,96}$/.test(errorCode??"")||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>32)return{ok:false,reason:"OUTBOX_RETRY_INPUT_INVALID"};
  const at=clock().toISOString();return tx(pool,async c=>{
   const q=await c.query("SELECT attempts FROM kratt_dispatch_outbox WHERE outbox_id=$1 AND status='LEASED' AND lease_token=$2 FOR UPDATE",[outboxId,leaseToken]);
   if(q.rowCount!==1)return{ok:false,reason:"LEASE_LOST"};const attempts=Number(q.rows[0].attempts),terminal=attempts>=maxAttempts,delay=Math.min(3600,2**Math.min(attempts,10)),available=new Date(Date.parse(at)+delay*1000).toISOString();
   await c.query("UPDATE kratt_dispatch_outbox SET status=$1,available_at=$2,last_error_code=$3,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$4 WHERE outbox_id=$5",
    [terminal?"DEAD":"PENDING",available,errorCode,at,outboxId]);return{ok:true,terminal,attempts,retry_at:terminal?null:available};
  });
 }
 async function cancelTask({taskId,actorId}={}){
  if(!validId(taskId)||!validId(actorId))return false;const at=clock().toISOString();return tx(pool,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[taskId]);
  const r=await c.query("INSERT INTO kratt_cancelled_tasks(task_id,cancelled_at,actor_id) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING RETURNING task_id",[taskId,at,actorId]);
   if(r.rowCount!==1)return false;await appendAudit(c,{schema_version:SCHEMA,event_id:"cancel:"+digest(taskId),event_type:"task.cancelled",created_at:at,actor_id:actorId,task_id:taskId});return true;
  });
 }
 return Object.freeze({appendDecision,reserveAuthorizedIntent,claimOutbox,finishOutbox,retryOutbox,cancelTask,verifyAuditChain});
}
