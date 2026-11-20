import { createHash, randomUUID } from "node:crypto";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HEX=/^[a-f0-9]{64}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const ZERO="0".repeat(64);
const plain=value=>!!value&&typeof value==="object"&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const validId=value=>typeof value==="string"&&ID.test(value);
const hash=value=>createHash("sha256").update(value,"utf8").digest("hex");

function stable(value){
 if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(Object.is(value,-0)?0:value);
 if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
 if(!plain(value))throw new TypeError("COMPETITIVE_SNAPSHOT_NOT_CANONICAL_JSON");
 const keys=Reflect.ownKeys(value);
 if(keys.some(key=>typeof key!=="string"))throw new TypeError("COMPETITIVE_SNAPSHOT_SYMBOL_KEY");
 return "{"+keys.sort().map(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!("value"in descriptor)||!descriptor.enumerable)
   throw new TypeError("COMPETITIVE_SNAPSHOT_ACCESSOR_REJECTED");
  return JSON.stringify(key)+":"+stable(descriptor.value);
 }).join(",")+"}";
}
function parseJson(value){
 if(typeof value==="string"){try{return JSON.parse(value);}catch{return null;}}
 return value&&typeof value==="object"?value:null;
}
function iso(value){
 const date=value instanceof Date?value:new Date(value);
 if(!Number.isFinite(date.getTime()))throw new TypeError("COMPETITIVE_STORE_CLOCK_INVALID");
 return date.toISOString();
}
async function transaction(pool,work){
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const result=await work(client);
  if(result===false||(result&&result.ok===false)){await client.query("ROLLBACK");return result;}
  await client.query("COMMIT");
  return result;
 }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}
 finally{client.release();}
}
function validSnapshot(snapshot){
 return plain(snapshot)&&validId(snapshot.snapshot_id)&&validId(snapshot.competitor_id)&&
  typeof snapshot.captured_at==="string"&&Number.isFinite(Date.parse(snapshot.captured_at))&&
  snapshot.source_verified===true&&DIGEST.test(snapshot.report_digest??"")&&
  snapshot.source&&validId(snapshot.source.channel_id)&&validId(snapshot.source.message_id)&&
  validId(snapshot.source.source_id)&&Number.isSafeInteger(snapshot.source.update_id)&&
  Array.isArray(snapshot.competitor_ids)&&Array.isArray(snapshot.claim_values)&&Array.isArray(snapshot.pricing_observations);
}

/**
 * PostgreSQL multi-host inbox and immutable competitor snapshot store.
 * The caller must apply 0002_competitive_intel_snapshots.sql before use.
 */
export function createPostgresCompetitiveIntelStore(pool,{clock=()=>new Date(),leaseMs=30_000}={}){
 if(!pool||typeof pool.connect!=="function")throw new TypeError("COMPETITIVE_POSTGRES_POOL_REQUIRED");
 if(typeof clock!=="function"||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>5*60_000)
  throw new TypeError("COMPETITIVE_POSTGRES_STORE_CONFIG_INVALID");

 async function claimUpdate({botId,updateId,payloadDigest,receivedAt}={}){
  if(!validId(botId)||!Number.isSafeInteger(updateId)||updateId<0||!DIGEST.test(payloadDigest??"")||
   typeof receivedAt!=="string"||!Number.isFinite(Date.parse(receivedAt)))return {status:"INVALID"};
  const now=iso(clock()),leaseToken="competitive-lease:"+randomUUID();
  const leaseUntil=new Date(Date.parse(now)+leaseMs).toISOString();
  return transaction(pool,async client=>{
   const inserted=await client.query(
    "INSERT INTO kratt_telegram_competitive_inbox(bot_id,update_id,payload_digest,status,lease_token,lease_until,received_at) VALUES($1,$2,$3,'PROCESSING',$4,$5,$6) ON CONFLICT(bot_id,update_id) DO NOTHING RETURNING update_id",
    [botId,updateId,payloadDigest,leaseToken,leaseUntil,receivedAt]);
   if(inserted.rowCount===1)return {status:"CLAIMED",leaseToken};
   const prior=await client.query(
    "SELECT payload_digest,status,lease_token,lease_until,snapshot_id,result_json FROM kratt_telegram_competitive_inbox WHERE bot_id=$1 AND update_id=$2 FOR UPDATE",
    [botId,updateId]);
   const row=prior.rows?.[0];
   if(!row)return {status:"ERROR"};
   if(row.payload_digest!==payloadDigest)return {status:"MISMATCH"};
   if(row.status==="COMPLETED")return {status:"DUPLICATE",result:parseJson(row.result_json),snapshotId:row.snapshot_id};
   const expiry=row.lease_until instanceof Date?row.lease_until.getTime():Date.parse(row.lease_until);
   if(row.status==="PROCESSING"&&Number.isFinite(expiry)&&expiry>Date.parse(now))return {status:"PENDING"};
   const reclaimed=await client.query(
    "UPDATE kratt_telegram_competitive_inbox SET status='PROCESSING',lease_token=$4,lease_until=$5,received_at=$6 WHERE bot_id=$1 AND update_id=$2 AND payload_digest=$3 AND status='PROCESSING' AND lease_until<=$7 RETURNING update_id",
    [botId,updateId,payloadDigest,leaseToken,leaseUntil,receivedAt,now]);
   return reclaimed.rowCount===1?{status:"CLAIMED",leaseToken}:{status:"PENDING"};
  });
 }

 async function getLatestSnapshot({competitorId}={}){
  if(!validId(competitorId))throw new TypeError("COMPETITOR_ID_INVALID");
  let snapshot=null,rowSnapshotId=null,rowDigest=null;
  const client=await pool.connect();
  try{
   const result=await client.query(
    "SELECT snapshot_id,competitor_id,snapshot_json,snapshot_digest FROM kratt_competitor_snapshots WHERE competitor_id=$1 ORDER BY captured_at DESC,snapshot_id DESC LIMIT 1",
    [competitorId]);
   const row=result.rows?.[0];
   if(!row)return null;
   snapshot=parseJson(row.snapshot_json);
   rowSnapshotId=row.snapshot_id;rowDigest=row.snapshot_digest;
   if(!validSnapshot(snapshot)||snapshot.snapshot_id!==rowSnapshotId||snapshot.competitor_id!==competitorId||
    !HEX.test(rowDigest??"")||hash(stable(snapshot))!==rowDigest)
    throw new Error("COMPETITOR_SNAPSHOT_INTEGRITY_FAILED");
   const eventResult=await client.query(
    "SELECT record_json FROM kratt_competitor_snapshot_events WHERE snapshot_id=$1 ORDER BY sequence DESC LIMIT 1",
    [rowSnapshotId]);
   const event=parseJson(eventResult.rows?.[0]?.record_json);
   if(!plain(event)||event.snapshot_id!==rowSnapshotId||event.snapshot_digest!==rowDigest)
    throw new Error("COMPETITOR_SNAPSHOT_EVENT_BINDING_INVALID");
  }finally{client.release();}
  const chain=await verifySnapshotChain();
  if(chain.ok!==true)throw new Error("COMPETITOR_SNAPSHOT_CHAIN_INVALID");
  return Object.freeze({...snapshot,verified:true});
 }

 async function commitSnapshot({
  botId,updateId,payloadDigest,leaseToken,snapshot,report,expectedPreviousSnapshotId=null,
 }={}){
  if(!validId(botId)||!Number.isSafeInteger(updateId)||updateId<0||!DIGEST.test(payloadDigest??"")||
   typeof leaseToken!=="string"||!/^competitive-lease:[0-9a-f-]{36}$/.test(leaseToken)||
   !validSnapshot(snapshot)||snapshot.source.update_id!==updateId||
   (expectedPreviousSnapshotId!==null&&!validId(expectedPreviousSnapshotId))||
   !report||report.report_digest!==snapshot.report_digest)
   return {ok:false,reason:"SNAPSHOT_COMMIT_INPUT_INVALID"};
  const capturedAt=iso(snapshot.captured_at),createdAt=iso(clock());
  const snapshotJson=stable(snapshot),snapshotDigest=hash(snapshotJson);
  const resultJson=stable({status:"COMMITTED",snapshot_id:snapshot.snapshot_id,report_digest:snapshot.report_digest});
  return transaction(pool,async client=>{
   const inbox=await client.query(
    "SELECT payload_digest,status,lease_token FROM kratt_telegram_competitive_inbox WHERE bot_id=$1 AND update_id=$2 FOR UPDATE",
    [botId,updateId]);
   const claim=inbox.rows?.[0];
   if(!claim||claim.status!=="PROCESSING"||claim.payload_digest!==payloadDigest||claim.lease_token!==leaseToken)
    return {ok:false,reason:"TELEGRAM_UPDATE_LEASE_LOST"};
   await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[snapshot.competitor_id]);
   const latest=await client.query(
    "SELECT snapshot_id FROM kratt_competitor_snapshots WHERE competitor_id=$1 ORDER BY captured_at DESC,snapshot_id DESC LIMIT 1 FOR UPDATE",
    [snapshot.competitor_id]);
   const latestId=latest.rows?.[0]?.snapshot_id??null;
   if(latestId!==expectedPreviousSnapshotId)return {ok:false,reason:"BASELINE_CHANGED"};
   await client.query(
    "INSERT INTO kratt_competitor_snapshots(snapshot_id,competitor_id,captured_at,bot_id,telegram_update_id,payload_digest,snapshot_json,snapshot_digest,previous_snapshot_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)",
    [snapshot.snapshot_id,snapshot.competitor_id,capturedAt,botId,updateId,payloadDigest,snapshotJson,snapshotDigest,latestId,createdAt]);
   const head=await client.query("SELECT sequence,hash FROM kratt_competitor_snapshot_head WHERE singleton=TRUE FOR UPDATE");
   const sequence=Number(head.rows?.[0]?.sequence??0)+1;
   const previousHash=head.rows?.[0]?.hash??ZERO;
   const event={
    schema_version:"kratt-competitor-snapshot-event/v1",
    event_id:"snapshot-event:"+snapshot.snapshot_id,
    event_type:"COMPETITOR_SNAPSHOT_COMMITTED",
    created_at:createdAt,
    snapshot_id:snapshot.snapshot_id,
    competitor_id:snapshot.competitor_id,
    snapshot_digest:snapshotDigest,
    previous_snapshot_id:latestId,
   };
   const recordJson=stable(event);
   const eventHash=hash(String(sequence)+"\n"+previousHash+"\n"+recordJson);
   await client.query(
    "INSERT INTO kratt_competitor_snapshot_events(sequence,event_id,snapshot_id,created_at,record_json,previous_hash,hash) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
    [sequence,event.event_id,snapshot.snapshot_id,createdAt,recordJson,previousHash,eventHash]);
   await client.query("UPDATE kratt_competitor_snapshot_head SET sequence=$1,hash=$2 WHERE singleton=TRUE",[sequence,eventHash]);
   const updated=await client.query(
    "UPDATE kratt_telegram_competitive_inbox SET status='COMPLETED',lease_token=NULL,lease_until=NULL,snapshot_id=$1,result_json=$2::jsonb,completed_at=$3 WHERE bot_id=$4 AND update_id=$5 AND payload_digest=$6 AND status='PROCESSING' AND lease_token=$7 RETURNING update_id",
    [snapshot.snapshot_id,resultJson,createdAt,botId,updateId,payloadDigest,leaseToken]);
   if(updated.rowCount!==1)throw new Error("TELEGRAM_UPDATE_COMPLETION_CONFLICT");
   return {ok:true,snapshotId:snapshot.snapshot_id,snapshotDigest,sequence,eventHash};
  });
 }

 async function releaseUpdate({botId,updateId,payloadDigest,leaseToken}={}){
  if(!validId(botId)||!Number.isSafeInteger(updateId)||!DIGEST.test(payloadDigest??"")||
   typeof leaseToken!=="string")return false;
  const result=await pool.query(
   "DELETE FROM kratt_telegram_competitive_inbox WHERE bot_id=$1 AND update_id=$2 AND payload_digest=$3 AND status='PROCESSING' AND lease_token=$4",
   [botId,updateId,payloadDigest,leaseToken]);
  return result.rowCount===1;
 }

 async function checkReady(){
  const found=[];
  const tables=[
   "kratt_telegram_competitive_inbox",
   "kratt_telegram_ingress_rate_limits",
   "kratt_competitor_snapshots",
   "kratt_competitor_snapshot_head",
   "kratt_competitor_snapshot_events"
  ];
  try{
   const client=await pool.connect();
   try{
    for(const table of tables){
     const result=await client.query("SELECT to_regclass($1) AS relation",[table]);
     if(!result.rows?.[0]?.relation)return Object.freeze({ready:false,reason:"COMPETITIVE_SCHEMA_INCOMPLETE",missing:table});
     found.push(table);
    }
   }finally{client.release();}
   const chain=await verifySnapshotChain();
   if(chain.ok!==true)return Object.freeze({ready:false,reason:"COMPETITIVE_SNAPSHOT_CHAIN_INVALID"});
   return Object.freeze({ready:true,reason:"COMPETITIVE_SNAPSHOT_STORE_READY",tables:found,chainSequence:chain.sequence});
  }catch{
   return Object.freeze({ready:false,reason:"COMPETITIVE_DATABASE_UNAVAILABLE"});
  }
 }

 async function verifySnapshotChain(){
  const client=await pool.connect();
  try{
   await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const events=await client.query("SELECT sequence,event_id,snapshot_id,record_json,previous_hash,hash FROM kratt_competitor_snapshot_events ORDER BY sequence");
   const head=await client.query("SELECT sequence,hash FROM kratt_competitor_snapshot_head WHERE singleton=TRUE");
   let sequence=0,previous=ZERO;
   for(const row of events.rows??[]){
    const next=Number(row.sequence),record=parseJson(row.record_json);
    if(next!==sequence+1||row.previous_hash!==previous||!plain(record))
     {await client.query("ROLLBACK");return {ok:false,reason:"SNAPSHOT_CHAIN_ORDER_OR_PREVIOUS_HASH_INVALID",sequence:next};}
    const actual=hash(String(next)+"\n"+previous+"\n"+stable(record));
    if(actual!==row.hash||record.event_id!==row.event_id||record.snapshot_id!==row.snapshot_id)
     {await client.query("ROLLBACK");return {ok:false,reason:"SNAPSHOT_CHAIN_HASH_INVALID",sequence:next};}
    sequence=next;previous=actual;
   }
   const current=head.rows?.[0];
   if(Number(current?.sequence??0)!==sequence||(current?.hash??ZERO)!==previous){
    await client.query("ROLLBACK");return {ok:false,reason:"SNAPSHOT_CHAIN_HEAD_MISMATCH"};
   }
   await client.query("COMMIT");
   return {ok:true,sequence,head:previous};
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}
  finally{client.release();}
 }

 return Object.freeze({claimUpdate,getLatestSnapshot,commitSnapshot,releaseUpdate,verifySnapshotChain,checkReady});
}
