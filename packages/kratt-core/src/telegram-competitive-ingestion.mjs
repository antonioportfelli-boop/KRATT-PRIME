import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TEMPORAL=new Set(["PRICE_CHANGE","RANKING_CHANGE","NEW_ENTRANT","FEATURE_CHANGE","GOVERNANCE_CHANGE"]);
const sha=value=>"sha256:"+createHash("sha256").update(value,"utf8").digest("hex");
const plain=value=>!!value&&typeof value==="object"&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));

function stable(value){
 if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(Object.is(value,-0)?0:value);
 if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
 if(!plain(value))throw new TypeError("TELEGRAM_UPDATE_NOT_CANONICAL_JSON");
 const keys=Reflect.ownKeys(value);
 if(keys.some(key=>typeof key!=="string"))throw new TypeError("TELEGRAM_UPDATE_SYMBOL_KEY");
 return "{"+keys.sort().map(key=>{
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(!d||!("value"in d)||!d.enumerable)throw new TypeError("TELEGRAM_UPDATE_ACCESSOR_REJECTED");
  return JSON.stringify(key)+":"+stable(d.value);
 }).join(",")+"}";
}

export function verifyCompetitiveTelegramSecret(received,expected){
 if(typeof received!=="string"||typeof expected!=="string"||received.length<1||expected.length<1)return false;
 const a=Buffer.from(received,"utf8"),b=Buffer.from(expected,"utf8");
 return a.length===b.length&&timingSafeEqual(a,b);
}

function validSecret(value){
 return typeof value==="string"&&value.length>=1&&value.length<=256&&/^[A-Za-z0-9_-]+$/.test(value);
}
function chatId(value){
 if(typeof value==="number"&&Number.isSafeInteger(value))return String(value);
 if(typeof value==="string"&&/^-?[0-9]{1,24}$/.test(value))return value;
 return null;
}
function makeSource(message,updateId,receivedAt){
 const rawChatId=chatId(message.chat?.id);
 const messageId=message.message_id;
 const channelAlias=rawChatId?.replace(/-/g,"n");
 const username=typeof message.chat?.username==="string"&&/^[A-Za-z0-9_]{5,32}$/.test(message.chat.username)
  ?message.chat.username:null;
 const observedAt=Number.isSafeInteger(message.date)&&message.date>0
  ?new Date(message.date*1000).toISOString():receivedAt;
 return Object.freeze({
  channel_id:"telegram-channel-"+channelAlias,
  message_id:"telegram-message-"+messageId,
  source_id:"telegram-source-"+channelAlias,
  source_type:"telegram",
  observed_at:observedAt,
  permalink:username?"https://t.me/"+username+"/"+messageId:null,
 });
}

function validateUpdate(update,{allowedChannelIds,maxTextBytes}){
 if(!plain(update)||!Number.isSafeInteger(update.update_id)||update.update_id<0)
  return {ok:false,reason:"TELEGRAM_UPDATE_ENVELOPE_INVALID"};
 const kinds=["channel_post","edited_channel_post"];
 const kind=kinds.find(key=>plain(update[key]));
 if(!kind)return {ok:false,reason:"TELEGRAM_CHANNEL_POST_REQUIRED"};
 const message=update[kind];
 const id=chatId(message.chat?.id);
 if(!id||!allowedChannelIds.has(id))return {ok:false,reason:"TELEGRAM_CHANNEL_NOT_ALLOWLISTED"};
 if(!Number.isSafeInteger(message.message_id)||message.message_id<1||
  !Number.isSafeInteger(message.date)||message.date<1||!Number.isFinite(new Date(message.date*1000).getTime()))
  return {ok:false,reason:"TELEGRAM_MESSAGE_METADATA_INVALID"};
 const text=typeof message.text==="string"?message.text:
  typeof message.caption==="string"?message.caption:null;
 if(typeof text!=="string"||text.trim().length===0)return {ok:false,reason:"TELEGRAM_TEXT_POST_REQUIRED"};
 const size=Buffer.byteLength(text,"utf8");
 if(size>maxTextBytes)return {ok:false,reason:"TELEGRAM_MESSAGE_TOO_LARGE"};
 return {ok:true,kind,message,text,chatId:id,updateId:update.update_id};
}

function buildSnapshot({signal,report,source,updateId,receivedAt,snapshotId}){
 const verified=new Set(report.verified_evidence_ids??[]);
 const supportedClaims=signal.claims.filter(claim=>report.claims.some(result=>
  result.claim_id===claim.claim_id&&result.competitor_id===claim.competitor_id&&result.evidence_status==="SUPPORTED"));
 const verifiedCompetitors=[...new Set(supportedClaims.map(claim=>claim.competitor_id))].sort();
 const claimValues=supportedClaims.filter(claim=>["FEATURE_CHANGE","GOVERNANCE_CHANGE"].includes(claim.kind)&&claim.current_value!==null)
  .map(claim=>Object.freeze({claim_key:claim.claim_key,kind:claim.kind,competitor_id:claim.competitor_id,
   value:claim.current_value,evidence_ids:Object.freeze(claim.assessments.map(a=>a.evidence_id).filter(id=>verified.has(id)).sort())}));
 const ranking=signal.ranking_snapshot&&verified.has(signal.ranking_snapshot.source_evidence_id)
  ?signal.ranking_snapshot:null;
 const offers=report.pricing?.verified_observations??[];
 return Object.freeze({
  snapshot_id:snapshotId,
  competitor_id:signal.primary_competitor,
  captured_at:receivedAt,
  source:{
   channel_id:source.channel_id,
   message_id:source.message_id,
   source_id:source.source_id,
   update_id:updateId,
   permalink:source.permalink,
  },
  competitor_ids:Object.freeze(verifiedCompetitors),
  claim_values:Object.freeze(claimValues),
  pricing_observations:Object.freeze([...offers]),
  ranking_snapshot:ranking?Object.freeze(ranking):null,
  report_status:report.status,
  weekly_change_status:report.weekly_change_status,
  report_digest:report.report_digest,
  source_verified:report.telegram_source_verified===true,
  snapshot_version:"kratt-competitor-snapshot/v1",
 });
}

/**
 * Converts authenticated Telegram channel posts into Wave 6 competitive signals.
 * Parsing and source verification remain injected; Telegram text is never an instruction.
 * The durable store claims the update, checks the optimistic snapshot head and commits
 * the inbox receipt plus immutable snapshot atomically.
 */
export function createTelegramCompetitiveIngestion({
 webhookSecret,botId,allowedChannelIds,parseSignal,engine,store,
 clock=()=>new Date(),maxTextBytes=16_384,maxBaselineRetries=2,
 makeSnapshotId=randomUUID,
}={}){
 if(!validSecret(webhookSecret))throw new TypeError("TELEGRAM_COMPETITIVE_WEBHOOK_SECRET_INVALID");
 if(typeof botId!=="string"||!ID.test(botId))throw new TypeError("TELEGRAM_BOT_ID_INVALID");
 if(!Array.isArray(allowedChannelIds)||allowedChannelIds.length<1||allowedChannelIds.length>128||
  allowedChannelIds.some(value=>!chatId(value)))throw new TypeError("TELEGRAM_CHANNEL_ALLOWLIST_REQUIRED");
 const channels=new Set(allowedChannelIds.map(chatId));
 if(typeof parseSignal!=="function"||!engine||typeof engine.analyze!=="function"||
  !store||!["claimUpdate","getLatestSnapshot","commitSnapshot","releaseUpdate"].every(key=>typeof store[key]==="function"))
  throw new TypeError("TELEGRAM_COMPETITIVE_DEPENDENCIES_REQUIRED");
 if(typeof clock!=="function"||typeof makeSnapshotId!=="function"||
  !Number.isInteger(maxTextBytes)||maxTextBytes<256||maxTextBytes>128*1024||
  !Number.isInteger(maxBaselineRetries)||maxBaselineRetries<0||maxBaselineRetries>5)
  throw new TypeError("TELEGRAM_COMPETITIVE_CONFIG_INVALID");

 async function ingest({update,receivedSecret}={}){
  if(!verifyCompetitiveTelegramSecret(receivedSecret,webhookSecret))
   return Object.freeze({status:"DENY",reason:"TELEGRAM_WEBHOOK_AUTHENTICATION_FAILED"});
  let payloadDigest;
  try{payloadDigest=sha(stable(update));}catch{return Object.freeze({status:"REJECTED",reason:"TELEGRAM_UPDATE_CANONICALIZATION_FAILED"});}
  const checked=validateUpdate(update,{allowedChannelIds:channels,maxTextBytes});
  if(!checked.ok)return Object.freeze({status:"REJECTED",reason:checked.reason});
  const {message,text,chatId:rawChatId,updateId,kind}=checked;
  let receivedAt;
  try{
   const nowValue=clock();
   const receivedDate=nowValue instanceof Date?new Date(nowValue.getTime()):new Date(nowValue);
   if(!Number.isFinite(receivedDate.getTime()))throw new Error("CLOCK_INVALID");
   receivedAt=receivedDate.toISOString();
  }catch{return Object.freeze({status:"ERROR",reason:"TELEGRAM_TRUSTED_CLOCK_UNAVAILABLE"});}
  let claim;
  try{claim=await store.claimUpdate({botId,updateId,payloadDigest,receivedAt});}
  catch{return Object.freeze({status:"ERROR",reason:"TELEGRAM_UPDATE_CLAIM_FAILED"});}
  if(claim?.status==="DUPLICATE")return Object.freeze({status:"DUPLICATE",reason:"TELEGRAM_UPDATE_ALREADY_COMMITTED",result:claim.result??null});
  if(claim?.status==="PENDING")return Object.freeze({status:"PENDING",reason:"TELEGRAM_UPDATE_LEASE_ACTIVE",updateId});
  if(claim?.status==="MISMATCH")return Object.freeze({status:"BLOCKED",reason:"TELEGRAM_UPDATE_ID_PAYLOAD_MISMATCH"});
  if(claim?.status!=="CLAIMED"||typeof claim.leaseToken!=="string")
   return Object.freeze({status:"ERROR",reason:"TELEGRAM_UPDATE_CLAIM_FAILED"});
  const leaseToken=claim.leaseToken;
  try{
   const source=makeSource(message,updateId,receivedAt);
   const sourceContext=Object.freeze({chatId:rawChatId,messageId:message.message_id,updateId,kind,source});
   const draft=await parseSignal(Object.freeze({text,source:sourceContext,receivedAt,updateId}));
   if(!plain(draft)||!Array.isArray(draft.claims)||!Array.isArray(draft.evidence)||
    !Array.isArray(draft.pricing_observations)||!Array.isArray(draft.competitor_ids))
    throw new Error("COMPETITIVE_SIGNAL_PARSER_OUTPUT_INVALID");
   const competitorId=draft.primary_competitor;
   if(typeof competitorId!=="string"||!ID.test(competitorId))
    throw new Error("COMPETITIVE_SIGNAL_PRIMARY_COMPETITOR_INVALID");
   for(let attempt=0;attempt<=maxBaselineRetries;attempt++){
    const baseline=await store.getLatestSnapshot({competitorId});
    const baselineId=baseline?.snapshot_id??null;
    const signal={
     ...draft,
     signal_id:"telegram-update-"+updateId,
     received_at:receivedAt,
     telegram_source:source,
     baseline_snapshot_id:baselineId,
     claims:draft.claims.map(claim=>{
      const priorValue=["FEATURE_CHANGE","GOVERNANCE_CHANGE"].includes(claim.kind)
       ?baseline?.claim_values?.find(item=>item.claim_key===claim.claim_key&&item.kind===claim.kind&&item.competitor_id===claim.competitor_id)?.value??null
       :null;
      return {...claim,baseline_ref:TEMPORAL.has(claim.kind)?baselineId:null,
       baseline_value:["FEATURE_CHANGE","GOVERNANCE_CHANGE"].includes(claim.kind)?priorValue:null};
     }),
    };
    const report=engine.analyze({signal,baseline});
    if(!report||["INPUT_INVALID","SOURCE_UNVERIFIED","EVIDENCE_INPUT_INVALID","REFLECTION_FAILED"].includes(report.status))
     throw new Error("COMPETITIVE_SIGNAL_REJECTED:"+String(report?.reason??report?.status??"UNKNOWN"));
    if(report.telegram_source_verified!==true)
     throw new Error("COMPETITIVE_TELEGRAM_SOURCE_NOT_VERIFIED");
    const snapshot=buildSnapshot({signal,report,source,updateId,receivedAt,snapshotId:makeSnapshotId()});
    const saved=await store.commitSnapshot({
     botId,updateId,payloadDigest,leaseToken,snapshot,report,expectedPreviousSnapshotId:baselineId,
    });
    if(saved?.ok===true)return Object.freeze({status:"OK",reason:"COMPETITIVE_SNAPSHOT_COMMITTED",
     updateId,snapshotId:snapshot.snapshot_id,report});
    if(saved?.reason==="BASELINE_CHANGED"&&attempt<maxBaselineRetries)continue;
    if(saved?.reason==="BASELINE_CHANGED")throw new Error("COMPETITIVE_BASELINE_CONTENTION");
    throw new Error("COMPETITIVE_SNAPSHOT_COMMIT_FAILED");
   }
   throw new Error("COMPETITIVE_BASELINE_RETRY_EXHAUSTED");
  }catch(error){
   try{await store.releaseUpdate({botId,updateId,payloadDigest,leaseToken});}catch{}
   const code=typeof error?.message==="string"&&/^[A-Z0-9:_-]{1,120}$/.test(error.message)
    ?error.message.split(":")[0]:"TELEGRAM_COMPETITIVE_INGESTION_FAILED";
   return Object.freeze({status:"ERROR",reason:code});
  }
 }
 return Object.freeze({ingest});
}
