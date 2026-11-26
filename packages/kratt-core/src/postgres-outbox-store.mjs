import { createHash, randomUUID } from "node:crypto";
import { incrementFabricMetric, setFabricGauge } from "./fabric-metrics.mjs";
const SCHEMA="kratt-audit/v1", ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/, HEX=/^[a-f0-9]{64}$/, ZERO="0".repeat(64);
const digest=v=>createHash("sha256").update(v,"utf8").digest("hex");
const validId=v=>typeof v==="string"&&ID.test(v);
const validIdempotencyKey=v=>typeof v==="string"&&/^kratt:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}:[a-f0-9]{64}$/.test(v);
const validTime=v=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v);
function stable(v){
 if(v===null||typeof v==="string"||typeof v==="boolean")return JSON.stringify(v);
 if(typeof v==="number"&&Number.isFinite(v))return JSON.stringify(Object.is(v,-0)?0:v);
 if(Array.isArray(v))return "["+v.map(stable).join(",")+"]";
 if(!v||typeof v!=="object"||Object.getPrototypeOf(v)!==Object.prototype)throw new TypeError("AUDIT_RECORD_NOT_JSON");
 const keys=Object.keys(v).sort();if(keys.length>128||keys.some(k=>["__proto__","constructor","prototype"].includes(k)))throw new TypeError("AUDIT_RECORD_KEYS_INVALID");
 return "{"+keys.map(k=>JSON.stringify(k)+":"+stable(v[k])).join(",")+"}";
}
const auditHash=(n,p,j)=>digest(String(n)+"\n"+p+"\n"+j);
async function tx(pool,work){
 const c=await pool.connect();
 try{
  await c.query("BEGIN");const r=await work(c);
  if(r===false||(r&&r.ok===false)){await c.query("ROLLBACK");return r;}
  await c.query("COMMIT");return r;
 }catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
 finally{c.release();}
}
export function createPostgresOutboxStore(pool,{clock=()=>new Date(),authorizeReconciliation,metrics=null}={}){
 if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new TypeError("POSTGRES_POOL_REQUIRED");
 if(typeof clock!=="function")throw new TypeError("TRUSTED_CLOCK_REQUIRED");
 async function refreshOutboxGauges(){
  if(!metrics)return;
  try{
   const q=await pool.query("SELECT count(*) FILTER (WHERE status='PENDING')::bigint AS pending, "+
    "count(*) FILTER (WHERE status='RECONCILE')::bigint AS reconcile FROM kratt_dispatch_outbox");
   setFabricGauge(metrics,"fabric_outbox_pending",Number(q.rows[0]?.pending??0));
   setFabricGauge(metrics,"fabric_outbox_reconcile_required",Number(q.rows[0]?.reconcile??0));
  }catch{}
 }
 async function stateTx(work){
  const result=await tx(pool,work);
  await refreshOutboxGauges();
  return result;
 }
 function nowIso(){
  const v=clock(),d=v instanceof Date?new Date(v.getTime()):new Date(v);
  if(!Number.isFinite(d.getTime()))throw new TypeError("TRUSTED_CLOCK_INVALID");
  return d.toISOString();
 }
 async function appendAudit(c,record){
  const json=stable(record);if(Buffer.byteLength(json,"utf8")>32768)throw new TypeError("AUDIT_RECORD_TOO_LARGE");
  const h=await c.query("SELECT sequence,hash FROM kratt_audit_head WHERE singleton=TRUE FOR UPDATE");
  const sequence=Number(h.rows[0]?.sequence??0)+1,previous=h.rows[0]?.hash??ZERO,hash=auditHash(sequence,previous,json);
  await c.query("INSERT INTO kratt_audit_events(sequence,event_id,event_type,created_at,record_json,previous_hash,hash) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
   [sequence,record.event_id,record.event_type,record.created_at,json,previous,hash]);
  await c.query("UPDATE kratt_audit_head SET sequence=$1,hash=$2 WHERE singleton=TRUE",[sequence,hash]);
  return{sequence,hash};
 }
 async function reserveAuthorizedIntent({task,principal,approval,idempotencyKey,providerPayload,provider,fabricEvent,ackPolicyRevision}={}){
  const at=nowIso();
  if(!task||!validId(task.task_id)||!principal||!validId(principal.id)||task.actor!==principal.id||
   !validId(approval?.key_id)||!validId(approval?.nonce)||!validId(approval?.approval_id)||!validTime(approval?.expires_at)||
   Date.parse(approval.expires_at)<=Date.parse(at)||!validIdempotencyKey(idempotencyKey)||!HEX.test(approval?.request_digest??"")||!HEX.test(approval?.signature_digest??""))
   return{ok:false,reason:"RESERVATION_INPUT_INVALID"};
  const selectedProvider=provider??task.constraints?.provider??"unknown";
  if(!validId(selectedProvider))return{ok:false,reason:"RESERVATION_PROVIDER_INVALID"};
  if(selectedProvider==="fabric"&&(!fabricEvent||!validId(ackPolicyRevision)))return{ok:false,reason:"FABRIC_ACK_POLICY_REVISION_REQUIRED"};
  if(fabricEvent&&(selectedProvider!=="fabric"||!validId(ackPolicyRevision)||!validId(fabricEvent.event_id)||!validId(fabricEvent.source_node)||
   !validId(fabricEvent.destination_node)||!validId(fabricEvent.key_id)||!HEX.test(fabricEvent.content_digest??"")||
   !Number.isSafeInteger(fabricEvent.sequence)||fabricEvent.sequence<1))return{ok:false,reason:"FABRIC_EVENT_INVALID"};
  const intentId="intent:"+digest(idempotencyKey),outboxId="outbox:"+digest(idempotencyKey);
  const event={schema_version:SCHEMA,event_id:intentId,event_type:fabricEvent?"fabric.outbound.intent_committed":"dispatch.intent_committed",
   created_at:at,actor_id:principal.id,task_id:task.task_id,provider:selectedProvider,operation:task.action,
   idempotency_key:idempotencyKey,approval_key_id:approval.key_id,approval_id:approval.approval_id,request_digest:approval.request_digest,
   ...(fabricEvent?{fabric_event_id:fabricEvent.event_id,fabric_source_node:fabricEvent.source_node,fabric_destination_node:fabricEvent.destination_node,
    fabric_sequence:fabricEvent.sequence,fabric_content_digest:fabricEvent.content_digest,fabric_key_id:fabricEvent.key_id,
    fabric_ack_policy_revision:ackPolicyRevision}:{})};
  try{
   return await tx(pool,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[task.task_id]);
    const nonce=await c.query("INSERT INTO kratt_approval_nonces(key_id,nonce,approval_id,expires_at,consumed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key_id,nonce) DO NOTHING RETURNING key_id",
     [approval.key_id,approval.nonce,approval.approval_id,approval.expires_at,at]);
    if(nonce.rowCount!==1)return{ok:false,reason:"APPROVAL_REPLAYED"};
    const cancelled=await c.query("SELECT task_id FROM kratt_cancelled_tasks WHERE task_id=$1 FOR UPDATE",[task.task_id]);
    if(cancelled.rowCount){incrementFabricMetric(metrics,"fabric_delivery_fence_rejected");return{ok:false,reason:"TASK_CANCELLED"};}
    const intent=await c.query("INSERT INTO kratt_dispatch_intents(idempotency_key,task_id,actor_id,provider,operation,status,created_at) VALUES($1,$2,$3,$4,$5,'INTENT_COMMITTED',$6) ON CONFLICT(idempotency_key) DO NOTHING RETURNING idempotency_key",
     [idempotencyKey,task.task_id,principal.id,event.provider,task.action,at]);
    if(intent.rowCount!==1){incrementFabricMetric(metrics,"fabric_idempotency_conflicts");return{ok:false,reason:"DUPLICATE_IDEMPOTENCY_KEY"};}
    await c.query("INSERT INTO kratt_dispatch_outbox(outbox_id,idempotency_key,provider,payload,status,available_at) VALUES($1,$2,$3,$4::jsonb,'PENDING',$5)",
     [outboxId,idempotencyKey,event.provider,JSON.stringify(providerPayload??(fabricEvent?{fabric_envelope:fabricEvent}:{task})),at]);
    if(fabricEvent){
     await c.query("INSERT INTO kratt_fabric_outbound_events(event_id,idempotency_key,source_node,destination_node,source_sequence,key_id,content_digest,issued_at,expires_at,event_json,ack_policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)",
      [fabricEvent.event_id,idempotencyKey,fabricEvent.source_node,fabricEvent.destination_node,fabricEvent.sequence,fabricEvent.key_id,fabricEvent.content_digest,fabricEvent.issued_at,fabricEvent.expires_at,JSON.stringify(fabricEvent),ackPolicyRevision]);
    }
    const audit=await appendAudit(c,event);return{ok:true,intent_id:intentId,outbox_id:outboxId,audit_sequence:audit.sequence};
   });
  }catch(e){if(e?.code==="23505"){incrementFabricMetric(metrics,"fabric_idempotency_conflicts");return{ok:false,reason:"DUPLICATE_OR_REPLAYED"};}throw e;}
 }
 async function reserveFabricSequence({sourceNode,idempotencyKey,requestDigest}={}){
  if(!validId(sourceNode)||!validIdempotencyKey(idempotencyKey)||!HEX.test(requestDigest??""))return{ok:false,reason:"FABRIC_SEQUENCE_INPUT_INVALID"};
  return stateTx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",["fabric-outbound:"+sourceNode]);
   const existing=await c.query("SELECT source_sequence,request_digest FROM kratt_fabric_outbound_sequences WHERE source_node=$1 AND idempotency_key=$2 FOR UPDATE",[sourceNode,idempotencyKey]);
   if(existing.rowCount===1){
    if(existing.rows[0].request_digest!==requestDigest)return{ok:false,reason:"FABRIC_SEQUENCE_REQUEST_CONFLICT"};
    return{ok:true,sequence:Number(existing.rows[0].source_sequence),duplicate:true};
   }
   await c.query("INSERT INTO kratt_fabric_outbound_heads(source_node,last_sequence) VALUES($1,0) ON CONFLICT(source_node) DO NOTHING",[sourceNode]);
   const head=await c.query("SELECT last_sequence FROM kratt_fabric_outbound_heads WHERE source_node=$1 FOR UPDATE",[sourceNode]);
   if(head.rowCount!==1)throw new Error("FABRIC_OUTBOUND_HEAD_UNAVAILABLE");
   const sequence=Number(head.rows[0].last_sequence)+1;
   if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error("FABRIC_OUTBOUND_SEQUENCE_INVALID");
   await c.query("UPDATE kratt_fabric_outbound_heads SET last_sequence=$2,updated_at=clock_timestamp() WHERE source_node=$1",[sourceNode,sequence]);
   await c.query("INSERT INTO kratt_fabric_outbound_sequences(source_node,idempotency_key,request_digest,source_sequence) VALUES($1,$2,$3,$4)",[sourceNode,idempotencyKey,requestDigest,sequence]);
   return{ok:true,sequence,duplicate:false};
  });
 }
 async function findOutboxByIdempotencyKey(idempotencyKey){
  if(!validIdempotencyKey(idempotencyKey))return{ok:false,reason:"IDEMPOTENCY_KEY_INVALID"};
  const q=await pool.query("SELECT o.provider,o.status,o.payload,o.attempts,o.available_at,o.last_error_code,o.delivery_started_at,o.manual_reconciliation_count,e.event_json,e.content_digest,e.ack_policy_revision,s.request_digest "+
   "FROM kratt_dispatch_outbox o LEFT JOIN kratt_fabric_outbound_events e ON e.idempotency_key=o.idempotency_key "+
   "LEFT JOIN kratt_fabric_outbound_sequences s ON s.source_node=e.source_node AND s.idempotency_key=o.idempotency_key WHERE o.idempotency_key=$1",[idempotencyKey]);
  if(q.rowCount!==1)return{ok:true,found:false};
  const r=q.rows[0];
  if(r.provider!=="fabric"||!r.event_json)return{ok:false,reason:"IDEMPOTENCY_KEY_USED_BY_OTHER_PROVIDER"};
  return{ok:true,found:true,status:r.status,attempts:Number(r.attempts),available_at:r.available_at,event:r.event_json,
   content_digest:r.content_digest,last_error_code:r.last_error_code,delivery_started_at:r.delivery_started_at,
   ack_policy_revision:r.ack_policy_revision,request_digest:r.request_digest,
   reconciliation_count:Number(r.manual_reconciliation_count)};
 }
 async function claimOutbox({workerId,limit=10,leaseSeconds=60}={}){
  if(!validId(workerId)||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>900)
   throw new TypeError("OUTBOX_CLAIM_OPTIONS_INVALID");
  const token=randomUUID(),at=nowIso(),until=new Date(Date.parse(at)+leaseSeconds*1000).toISOString();
  return stateTx(async c=>{
   const expired=await c.query("UPDATE kratt_dispatch_outbox SET status='RECONCILE',lease_owner=NULL,lease_token=NULL,lease_until=NULL,"+
    "last_error_code='DELIVERY_LEASE_EXPIRED_AFTER_START',updated_at=$1 "+
    "WHERE status='LEASED' AND lease_until<=$1 AND delivery_started_at IS NOT NULL RETURNING outbox_id",[at]);
   if(expired.rowCount>0)incrementFabricMetric(metrics,"fabric_delivery_lease_expired",expired.rowCount);
   const attemptColumn = await c.query(
    "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() " +
    "AND table_name='kratt_dispatch_outbox' AND column_name='delivery_attempt_sequence') AS available"
   );
   const hasAttemptSequence = attemptColumn.rows[0]?.available === true;
   const attemptSequenceUpdate = hasAttemptSequence ? ",delivery_attempt_sequence=o.delivery_attempt_sequence+1" : "";
   const attemptSequenceReturn = hasAttemptSequence
    ? "o.delivery_attempt_sequence AS delivery_attempt_sequence"
    : "o.attempts AS delivery_attempt_sequence";
   const r=await c.query(
    "WITH picked AS ("+
    " SELECT o.outbox_id FROM kratt_dispatch_outbox o "+
    " JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key "+
    " WHERE ((o.status='PENDING' AND o.available_at<=$1) OR "+
    " (o.status='LEASED' AND o.lease_until<=$1 AND o.delivery_started_at IS NULL)) "+
    " AND i.status='INTENT_COMMITTED' "+
    " AND NOT EXISTS(SELECT 1 FROM kratt_cancelled_tasks x WHERE x.task_id=i.task_id) "+
    " ORDER BY o.available_at,o.outbox_id FOR UPDATE SKIP LOCKED LIMIT $2"+
    ") "+
    "UPDATE kratt_dispatch_outbox o SET status='LEASED',lease_owner=$3,lease_token=$4,lease_until=$5,"+
    "attempts=o.attempts+1"+attemptSequenceUpdate+",delivery_started_at=NULL,delivery_lease_token=NULL,updated_at=$1 "+
    "FROM picked, kratt_dispatch_intents i "+
    "WHERE o.outbox_id=picked.outbox_id AND i.idempotency_key=o.idempotency_key "+
    "RETURNING o.outbox_id,o.idempotency_key,o.provider,o.payload,o.attempts,o.lease_token,o.lease_until,i.task_id,"+attemptSequenceReturn,
    [at,limit,workerId,token,until]);
   return r.rows;
  });
 }
 async function beginOutboxDelivery({outboxId,leaseToken}={}){
  if(!validId(outboxId)||typeof leaseToken!=="string"||leaseToken.length<16||leaseToken.length>128)
   return{ok:false,reason:"OUTBOX_DELIVERY_INPUT_INVALID"};
  const at=nowIso();
  return stateTx(async c=>{
   const identity=await c.query("SELECT i.task_id FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key WHERE o.outbox_id=$1",[outboxId]);
   if(identity.rowCount!==1)return{ok:false,reason:"OUTBOX_NOT_FOUND"};
   const taskId=identity.rows[0].task_id;
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[taskId]);
   const q=await c.query("SELECT o.status,o.lease_token,o.lease_until,o.delivery_started_at,o.delivery_lease_token,"+
    "i.task_id,i.status AS intent_status FROM kratt_dispatch_outbox o "+
    "JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key "+
    "WHERE o.outbox_id=$1 FOR UPDATE OF o,i",[outboxId]);
   if(q.rowCount!==1)return{ok:false,reason:"OUTBOX_NOT_FOUND"};
   const r=q.rows[0];
   if(r.task_id!==taskId)return{ok:false,reason:"TASK_BINDING_CONFLICT"};
   if(r.status!=="LEASED"||r.lease_token!==leaseToken||!r.lease_until||Date.parse(new Date(r.lease_until).toISOString())<=Date.parse(at)){
    incrementFabricMetric(metrics,"fabric_delivery_fence_rejected");
    return{ok:false,reason:"LEASE_LOST"};
   }
   if(r.intent_status!=="INTENT_COMMITTED"){incrementFabricMetric(metrics,"fabric_delivery_fence_rejected");return{ok:false,reason:"INTENT_TERMINAL"};}
   const cancelled=await c.query("SELECT task_id FROM kratt_cancelled_tasks WHERE task_id=$1",[taskId]);
   if(cancelled.rowCount)return{ok:false,reason:"TASK_CANCELLED"};
   if(r.delivery_started_at){
    if(r.delivery_lease_token===leaseToken)return{ok:true,duplicate:true,task_id:taskId,delivery_started_at:r.delivery_started_at};
    incrementFabricMetric(metrics,"fabric_delivery_fence_rejected");
    return{ok:false,reason:"DELIVERY_RECONCILIATION_REQUIRED"};
   }
   await c.query("UPDATE kratt_dispatch_outbox SET delivery_started_at=$2,delivery_lease_token=$3,updated_at=$2 WHERE outbox_id=$1",
    [outboxId,at,leaseToken]);
   return{ok:true,duplicate:false,task_id:taskId,delivery_started_at:at};
  });
 }
 async function finishOutbox({outboxId,leaseToken,outcome,actorId,taskId}={}){
  if(!validId(outboxId)||typeof leaseToken!=="string"||!validId(actorId)||!validId(taskId)||
   !["COMPLETED","FAILED"].includes(outcome?.status))return{ok:false,reason:"OUTBOX_FINISH_INPUT_INVALID"};
  const at=nowIso();
  return stateTx(async c=>{
   const q=await c.query("SELECT o.idempotency_key,o.provider,o.attempts,o.delivery_started_at,o.delivery_lease_token,"+
    "i.task_id FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key "+
    "WHERE o.outbox_id=$1 AND o.status='LEASED' AND o.lease_token=$2 FOR UPDATE OF o,i",[outboxId,leaseToken]);
   if(q.rowCount!==1)return{ok:false,reason:"LEASE_LOST"};
   const item=q.rows[0];
   if(item.task_id!==taskId)return{ok:false,reason:"TASK_BINDING_MISMATCH"};
   if(!item.delivery_started_at||item.delivery_lease_token!==leaseToken)return{ok:false,reason:"DELIVERY_NOT_STARTED"};
   const event={schema_version:SCHEMA,event_id:"outcome:"+digest(item.idempotency_key),
    event_type:outcome.status==="COMPLETED"?"dispatch.completed":"dispatch.failed",created_at:at,
    actor_id:actorId,task_id:item.task_id,provider:item.provider,idempotency_key:item.idempotency_key,
    result:{status:outcome.status.toLowerCase()}};
   await appendAudit(c,event);
   const iu=await c.query("UPDATE kratt_dispatch_intents SET status=$1,updated_at=$2 WHERE idempotency_key=$3 AND status='INTENT_COMMITTED' RETURNING idempotency_key",
    [outcome.status,at,item.idempotency_key]);
   if(iu.rowCount!==1)throw new Error("INTENT_STATE_CONFLICT");
   const ou=await c.query("UPDATE kratt_dispatch_outbox SET status='DONE',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$1 "+
    "WHERE outbox_id=$2 AND status='LEASED' AND lease_token=$3 RETURNING outbox_id",[at,outboxId,leaseToken]);
   if(ou.rowCount!==1)throw new Error("OUTBOX_LEASE_CONFLICT");
   return{ok:true};
  });
 }
 async function retryOutbox({outboxId,leaseToken,errorCode,maxAttempts=8,retrySafety="UNKNOWN"}={}){
  if(!validId(outboxId)||typeof leaseToken!=="string"||!/^[A-Z0-9_:-]{1,96}$/.test(errorCode??"")||
   !Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>32||!["SAFE_TO_RETRY","UNKNOWN"].includes(retrySafety))
   return{ok:false,reason:"OUTBOX_RETRY_INPUT_INVALID"};
  const at=nowIso();
  return stateTx(async c=>{
   const q=await c.query("SELECT o.attempts,o.delivery_started_at,o.delivery_lease_token,o.idempotency_key,o.provider,"+
    "i.task_id,o.lease_owner FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key "+
    "WHERE o.outbox_id=$1 AND o.status='LEASED' AND o.lease_token=$2 FOR UPDATE OF o,i",[outboxId,leaseToken]);
   if(q.rowCount!==1)return{ok:false,reason:"LEASE_LOST"};
   const r=q.rows[0],attempts=Number(r.attempts);
   const canRetry=retrySafety==="SAFE_TO_RETRY"||!r.delivery_started_at;
   if(!canRetry){
    await c.query("UPDATE kratt_dispatch_outbox SET status='RECONCILE',lease_owner=NULL,lease_token=NULL,lease_until=NULL,"+
     "last_error_code=$2,updated_at=$3 WHERE outbox_id=$1",[outboxId,errorCode,at]);
    await appendAudit(c,{schema_version:SCHEMA,event_id:"reconcile-required:"+digest(r.idempotency_key+":"+String(attempts)),
     event_type:"dispatch.reconcile_required",created_at:at,actor_id:r.lease_owner,task_id:r.task_id,
     provider:r.provider,idempotency_key:r.idempotency_key,attempts,error_code:errorCode});
    return{ok:true,status:"RECONCILE",terminal:false,reconciliation_required:true,attempts,retry_at:null};
   }
   const terminal=attempts>=maxAttempts;
   const delay=Math.min(3600,2**Math.min(attempts,10));
   const available=new Date(Date.parse(at)+delay*1000).toISOString();
   const status=terminal?"DEAD":"PENDING";
   await c.query("UPDATE kratt_dispatch_outbox SET status=$1,available_at=$2,last_error_code=$3,"+
    "lease_owner=NULL,lease_token=NULL,lease_until=NULL,delivery_started_at=NULL,delivery_lease_token=NULL,updated_at=$4 WHERE outbox_id=$5",
    [status,available,errorCode,at,outboxId]);
   await appendAudit(c,{schema_version:SCHEMA,event_id:"retry:"+digest(r.idempotency_key+":"+String(attempts)),
    event_type:terminal?"dispatch.dead_lettered":"dispatch.retry_scheduled",created_at:at,actor_id:r.lease_owner,
    task_id:r.task_id,provider:r.provider,idempotency_key:r.idempotency_key,attempts,error_code:errorCode,retry_at:terminal?null:available});
   return{ok:true,status,terminal,reconciliation_required:false,attempts,retry_at:terminal?null:available};
  });
 }
 async function cancelTaskWithReason({taskId,actorId}={}){
  if(!validId(taskId)||!validId(actorId))return{ok:false,reason:"CANCEL_INPUT_INVALID"};
  const at=nowIso();
  const result=await stateTx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[taskId]);
   const existing=await c.query("SELECT task_id FROM kratt_cancelled_tasks WHERE task_id=$1 FOR UPDATE",[taskId]);
   if(existing.rowCount)return{ok:true,duplicate:true,task_id:taskId,cancelled_outbox_count:0};
   const items=await c.query("SELECT o.outbox_id,o.status,o.delivery_started_at,i.status AS intent_status "+
    "FROM kratt_dispatch_intents i JOIN kratt_dispatch_outbox o ON o.idempotency_key=i.idempotency_key "+
    "WHERE i.task_id=$1 FOR UPDATE OF i,o",[taskId]);
   if(items.rows.some(x=>x.status==="DONE"||x.intent_status==="COMPLETED"||x.intent_status==="FAILED"))
    return{ok:false,reason:"TASK_ALREADY_TERMINAL"};
   if(items.rows.some(x=>x.delivery_started_at))
    return{ok:false,reason:"DELIVERY_ALREADY_STARTED"};
   if(items.rows.some(x=>x.status==="DEAD"||x.status==="RECONCILE"))
    return{ok:false,reason:"RECONCILIATION_REQUIRED"};
   const inserted=await c.query("INSERT INTO kratt_cancelled_tasks(task_id,cancelled_at,actor_id) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING RETURNING task_id",
    [taskId,at,actorId]);
   if(inserted.rowCount!==1)return{ok:true,duplicate:true,task_id:taskId,cancelled_outbox_count:0};
   const cancelled=await c.query("UPDATE kratt_dispatch_outbox o SET status='CANCELLED',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2 "+
    "FROM kratt_dispatch_intents i WHERE i.idempotency_key=o.idempotency_key AND i.task_id=$1 "+
    "AND o.status IN ('PENDING','LEASED') AND o.delivery_started_at IS NULL RETURNING o.outbox_id",[taskId,at]);
   await c.query("UPDATE kratt_dispatch_intents SET status='CANCELLED',updated_at=$2 WHERE task_id=$1 AND status='INTENT_COMMITTED'",[taskId,at]);
   await appendAudit(c,{schema_version:SCHEMA,event_id:"cancel:"+digest(taskId),event_type:"task.cancelled",
    created_at:at,actor_id:actorId,task_id:taskId,result:{cancelled_outbox_count:cancelled.rowCount}});
   return{ok:true,duplicate:false,task_id:taskId,cancelled_outbox_count:cancelled.rowCount};
  });
  if(result?.ok===true && result.duplicate!==true)incrementFabricMetric(metrics,"fabric_task_cancelled");
  return result;
 }
 async function cancelTask(input={}){const r=await cancelTaskWithReason(input);return r.ok===true;}
 async function reconcileOutbox({outboxId,actorId,decision,evidenceDigest,reason}={}){
  if(!validId(outboxId)||!validId(actorId)||!["SAFE_TO_RETRY","CONFIRMED_DELIVERED","CANCELLED"].includes(decision)||
   !HEX.test(evidenceDigest??"")||typeof reason!=="string"||reason.trim().length<3||reason.length>512)
   return{ok:false,reason:"OUTBOX_RECONCILIATION_INPUT_INVALID"};
  if(typeof authorizeReconciliation!=="function")return{ok:false,reason:"RECONCILIATION_AUTHORITY_REQUIRED"};
  let permitted=false;
  try{permitted=await authorizeReconciliation({action:"OUTBOX_RECONCILE",actorId,outboxId,decision,evidenceDigest,reason})===true;}
  catch{permitted=false;}
  if(!permitted)return{ok:false,reason:"RECONCILIATION_DENIED"};
  const at=nowIso(),reconciliationId="reconcile:"+digest(outboxId+":"+evidenceDigest);
  const identity=await pool.query("SELECT i.task_id FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key WHERE o.outbox_id=$1",[outboxId]);
  if(identity.rowCount!==1)return{ok:false,reason:"OUTBOX_NOT_FOUND"};
  const taskId=identity.rows[0].task_id;
  return stateTx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[taskId]);
   const q=await c.query("SELECT o.status,o.idempotency_key,o.attempts,o.manual_reconciliation_count,i.task_id,i.status AS intent_status "+
    "FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key "+
    "WHERE o.outbox_id=$1 FOR UPDATE OF o,i",[outboxId]);
   if(q.rowCount!==1)return{ok:false,reason:"OUTBOX_NOT_FOUND"};
   const r=q.rows[0];
   if(!["DEAD","RECONCILE"].includes(r.status))return{ok:false,reason:"OUTBOX_NOT_RECONCILABLE"};
   if(Number(r.manual_reconciliation_count)>=16)return{ok:false,reason:"RECONCILIATION_LIMIT_REACHED"};
   if(r.intent_status!=="INTENT_COMMITTED")return{ok:false,reason:"INTENT_TERMINAL"};
   const log=await c.query("INSERT INTO kratt_dispatch_outbox_reconciliations"+
    "(reconciliation_id,outbox_id,idempotency_key,task_id,decision,evidence_digest,reason,actor_id,created_at) "+
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(outbox_id,evidence_digest) DO NOTHING RETURNING reconciliation_id",
    [reconciliationId,outboxId,r.idempotency_key,taskId,decision,evidenceDigest,reason,actorId,at]);
   if(log.rowCount!==1)return{ok:false,reason:"RECONCILIATION_EVIDENCE_REPLAYED"};
   if(decision==="SAFE_TO_RETRY"){
    await c.query("UPDATE kratt_dispatch_outbox SET status='PENDING',attempts=0,available_at=$2,last_error_code=NULL,"+
     "lease_owner=NULL,lease_token=NULL,lease_until=NULL,delivery_started_at=NULL,delivery_lease_token=NULL,"+
     "manual_reconciliation_count=manual_reconciliation_count+1,updated_at=$2 WHERE outbox_id=$1",[outboxId,at]);
   }else if(decision==="CONFIRMED_DELIVERED"){
    const intent=await c.query("UPDATE kratt_dispatch_intents SET status='COMPLETED',updated_at=$2 WHERE idempotency_key=$1 AND status='INTENT_COMMITTED' RETURNING idempotency_key",
     [r.idempotency_key,at]);
    if(intent.rowCount!==1)throw new Error("RECONCILIATION_INTENT_CONFLICT");
    await c.query("UPDATE kratt_dispatch_outbox SET status='DONE',lease_owner=NULL,lease_token=NULL,lease_until=NULL,"+
     "manual_reconciliation_count=manual_reconciliation_count+1,updated_at=$2 WHERE outbox_id=$1",[outboxId,at]);
   }else{
    await c.query("INSERT INTO kratt_cancelled_tasks(task_id,cancelled_at,actor_id) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING",
     [taskId,at,actorId]);
    const intent=await c.query("UPDATE kratt_dispatch_intents SET status='CANCELLED',updated_at=$2 WHERE idempotency_key=$1 AND status='INTENT_COMMITTED' RETURNING idempotency_key",
     [r.idempotency_key,at]);
    if(intent.rowCount!==1)throw new Error("RECONCILIATION_INTENT_CONFLICT");
    await c.query("UPDATE kratt_dispatch_outbox SET status='CANCELLED',lease_owner=NULL,lease_token=NULL,lease_until=NULL,"+
     "manual_reconciliation_count=manual_reconciliation_count+1,updated_at=$2 WHERE outbox_id=$1",[outboxId,at]);
   }
   await appendAudit(c,{schema_version:SCHEMA,event_id:reconciliationId,event_type:"dispatch.outbox.reconciled",
    created_at:at,actor_id:actorId,task_id:taskId,outbox_id:outboxId,idempotency_key:r.idempotency_key,
    decision,evidence_digest:evidenceDigest,reason});
   return{ok:true,decision,reconciliation_id:reconciliationId,task_id:taskId};
  });
 }
 return Object.freeze({
  reserveAuthorizedIntent,reserveFabricSequence,findOutboxByIdempotencyKey,claimOutbox,
  beginOutboxDelivery,finishOutbox,retryOutbox,cancelTask,cancelTaskWithReason,reconcileOutbox
 });
}
