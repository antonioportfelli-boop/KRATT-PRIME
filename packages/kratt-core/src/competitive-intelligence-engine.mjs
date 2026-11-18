import { createHash } from "node:crypto";
import { validateEvidenceRecord } from "./contracts.mjs";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const KINDS=new Set(["PRICING_CATALOG","PRICE_CHANGE","RANKING_CHANGE","NEW_ENTRANT","FEATURE_CHANGE","GOVERNANCE_CHANGE"]);
const TEMPORAL=new Set(["PRICE_CHANGE","RANKING_CHANGE","NEW_ENTRANT","FEATURE_CHANGE","GOVERNANCE_CHANGE"]);
const BILLING=new Set(["USER_MONTH","CONVERSATION","CREDITS_100K"]);
const USAGE=new Set(["INCLUDED","FLAT","METERED_FLEX","PER_CONVERSATION","FLEX_PACK"]);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const plain=v=>!!v&&typeof v==="object"&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{
 const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&"value"in d&&!d.get&&!d.set;
});
const validId=v=>typeof v==="string"&&ID.test(v);
const validTime=v=>typeof v==="string"&&TIME.test(v)&&Number.isFinite(Date.parse(v));
const validHttps=v=>{try{return new URL(v).protocol==="https:";}catch{return false;}};
const uniqIds=v=>Array.isArray(v)&&new Set(v).size===v.length&&v.every(validId);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const finiteNonnegative=v=>typeof v==="number"&&Number.isFinite(v)&&v>=0;

function validateOffer(o){
 const keys=["observation_id","competitor_id","sku","price","currency","billing_unit","usage_model",
  "region","source_evidence_id","requires_flex_credits","credits_per_action","credit_pack_price","credit_pack_size","observed_at"];
 if(!exact(o,keys))return "PRICING_OBSERVATION_SHAPE_INVALID";
 if(!validId(o.observation_id)||!validId(o.competitor_id)||!validId(o.sku)||!validId(o.region)||
  !validId(o.source_evidence_id)||!finiteNonnegative(o.price)||typeof o.currency!=="string"||
  !/^[A-Z]{3}$/.test(o.currency)||!BILLING.has(o.billing_unit)||!USAGE.has(o.usage_model)||
  typeof o.requires_flex_credits!=="boolean"||!validTime(o.observed_at))return "PRICING_OBSERVATION_VALUE_INVALID";
 if(o.credits_per_action!==null&&(!Number.isInteger(o.credits_per_action)||o.credits_per_action<1))return "FLEX_CREDIT_ACTION_INVALID";
 if(o.credit_pack_price!==null&&!finiteNonnegative(o.credit_pack_price))return "FLEX_CREDIT_PRICE_INVALID";
 if(o.credit_pack_size!==null&&(!Number.isInteger(o.credit_pack_size)||o.credit_pack_size<1))return "FLEX_CREDIT_SIZE_INVALID";
 if(o.usage_model==="METERED_FLEX"&&(!o.requires_flex_credits||!o.credits_per_action||!o.credit_pack_price||!o.credit_pack_size))return "FLEX_CREDIT_TERMS_REQUIRED";
 if(o.usage_model==="FLEX_PACK"&&(o.billing_unit!=="CREDITS_100K"||!o.credits_per_action||!o.credit_pack_price||!o.credit_pack_size))return "FLEX_PACK_TERMS_INVALID";
 if(o.usage_model==="PER_CONVERSATION"&&o.billing_unit!=="CONVERSATION")return "CONVERSATION_UNIT_MISMATCH";
 if(o.billing_unit==="CONVERSATION"&&o.usage_model!=="PER_CONVERSATION")return "CONVERSATION_MODEL_MISMATCH";
 if(o.billing_unit==="USER_MONTH"&&o.usage_model==="PER_CONVERSATION")return "USER_MONTH_MODEL_MISMATCH";
 return null;
}

function validateSignal(s){
 const keys=["signal_id","received_at","period","telegram_source","primary_competitor","competitor_ids",
  "recommendation_competitor_ids","monitoring_checks","baseline_snapshot_id","claims","evidence","pricing_observations","ranking_snapshot"];
 if(!exact(s,keys))return "SIGNAL_ENVELOPE_INVALID";
 if(!validId(s.signal_id)||!validTime(s.received_at)||!validId(s.primary_competitor)||
  !uniqIds(s.competitor_ids)||!s.competitor_ids.includes(s.primary_competitor)||
  !uniqIds(s.recommendation_competitor_ids)||!Array.isArray(s.monitoring_checks)||
  s.monitoring_checks.some(k=>!TEMPORAL.has(k))||new Set(s.monitoring_checks).size!==s.monitoring_checks.length||
  (s.baseline_snapshot_id!==null&&!validId(s.baseline_snapshot_id)))return "SIGNAL_METADATA_INVALID";
 if(!exact(s.period,["label","starts_at","ends_at"])||!validId(s.period.label)||
  !validTime(s.period.starts_at)||!validTime(s.period.ends_at)||Date.parse(s.period.starts_at)>=Date.parse(s.period.ends_at))
  return "SIGNAL_PERIOD_INVALID";
 if(!exact(s.telegram_source,["channel_id","message_id","source_id","source_type","observed_at","permalink"])||
  !validId(s.telegram_source.channel_id)||!validId(s.telegram_source.message_id)||
  !validId(s.telegram_source.source_id)||!validId(s.telegram_source.source_type)||
  !validTime(s.telegram_source.observed_at)||
  (s.telegram_source.permalink!==null&&(typeof s.telegram_source.permalink!=="string"||!validHttps(s.telegram_source.permalink))))return "TELEGRAM_PROVENANCE_INVALID";
 if(!Array.isArray(s.evidence)||s.evidence.length>256)return "EVIDENCE_SET_INVALID";
 const evidenceIds=new Set();
 for(const e of s.evidence){const v=validateEvidenceRecord(e);if(!v.ok||evidenceIds.has(e.evidence_id))return "EVIDENCE_INVALID_OR_DUPLICATE";evidenceIds.add(e.evidence_id);}
 if(!Array.isArray(s.claims)||s.claims.length>64)return "CLAIMS_INVALID";
 const claimIds=new Set();
 for(const c of s.claims){
  if(!exact(c,["claim_id","kind","competitor_id","statement","baseline_ref","observation_ref","baseline_value","current_value","assessments"])||
   !validId(c.claim_id)||!KINDS.has(c.kind)||!validId(c.competitor_id)||
   typeof c.statement!=="string"||c.statement.length<1||c.statement.length>1200||
   (c.baseline_ref!==null&&!validId(c.baseline_ref))||(c.observation_ref!==null&&!validId(c.observation_ref))||
   ![null,"string","number"].includes(c.baseline_value===null?null:typeof c.baseline_value)||
   ![null,"string","number"].includes(c.current_value===null?null:typeof c.current_value)||
   !Array.isArray(c.assessments)||claimIds.has(c.claim_id))return "CLAIM_INVALID";
  claimIds.add(c.claim_id);
  for(const a of c.assessments)if(!exact(a,["evidence_id","stance","rationale_code"])||
   !validId(a.evidence_id)||!["SUPPORTS","REFUTES"].includes(a.stance)||!validId(a.rationale_code)||
   !evidenceIds.has(a.evidence_id))return "CLAIM_ASSESSMENT_INVALID";
 }
 if(!Array.isArray(s.pricing_observations)||s.pricing_observations.length>128)return "PRICING_OBSERVATIONS_INVALID";
 const offerIds=new Set();
 for(const o of s.pricing_observations){
  const err=validateOffer(o);if(err)return err;
  if(offerIds.has(o.observation_id))return "PRICING_OBSERVATION_DUPLICATE";
  if(!evidenceIds.has(o.source_evidence_id))return "PRICING_EVIDENCE_NOT_FOUND";
  offerIds.add(o.observation_id);
 }
 if(s.ranking_snapshot!==null){
  if(!exact(s.ranking_snapshot,["universe_id","observed_at","entries"])||!validId(s.ranking_snapshot.universe_id)||
   !validTime(s.ranking_snapshot.observed_at)||!Array.isArray(s.ranking_snapshot.entries)||s.ranking_snapshot.entries.length>100)
   return "RANKING_SNAPSHOT_INVALID";
  const ranks=new Set(),competitors=new Set();
  for(const r of s.ranking_snapshot.entries)if(!exact(r,["competitor_id","rank"])||!validId(r.competitor_id)||
   !Number.isInteger(r.rank)||r.rank<1||r.rank>100||ranks.has(r.rank)||competitors.has(r.competitor_id))
   return "RANKING_ENTRY_INVALID";else{ranks.add(r.rank);competitors.add(r.competitor_id);}
 }
 return null;
}

function comparePrice(current,baseline){
 if(!baseline||!Array.isArray(baseline.pricing_observations))return {status:"BASELINE_MISSING"};
 const prior=baseline.pricing_observations.find(p=>p.competitor_id===current.competitor_id&&p.sku===current.sku&&
  p.currency===current.currency&&p.billing_unit===current.billing_unit&&p.region===current.region);
 if(!prior)return {status:"COMPARABLE_BASELINE_MISSING"};
 if(!validTime(prior.observed_at)||Date.parse(prior.observed_at)>=Date.parse(current.observed_at)||
  !finiteNonnegative(prior.price))return {status:"BASELINE_NOT_COMPARABLE"};
 const delta=current.price-prior.price;
 return {status:delta===0?"NO_CHANGE_FOUND":"DELTA_FOUND",previous_price:prior.price,current_price:current.price,
  absolute_delta:delta,percentage_delta:prior.price===0?null:Number(((delta/prior.price)*100).toFixed(4)),
  currency:current.currency,billing_unit:current.billing_unit,baseline_observed_at:prior.observed_at};
}
function compareRanks(current,baseline){
 if(!current||!baseline?.ranking_snapshot)return {status:"BASELINE_MISSING"};
 const prior=baseline.ranking_snapshot;
 if(prior.universe_id!==current.universe_id)return {status:"COMPARISON_SCOPE_MISMATCH"};
 const old=new Map(prior.entries.map(e=>[e.competitor_id,e.rank]));
 const changed=current.entries.filter(e=>old.has(e.competitor_id)&&old.get(e.competitor_id)!==e.rank)
  .map(e=>({competitor_id:e.competitor_id,previous_rank:old.get(e.competitor_id),current_rank:e.rank,delta:old.get(e.competitor_id)-e.rank}));
 const added=current.entries.filter(e=>!old.has(e.competitor_id)).map(e=>e.competitor_id);
 return {status:changed.length||added.length?"DELTA_FOUND":"NO_CHANGE_FOUND",changed,added};
}

export function calculateMonthlyTco({offers,seats=0,actionsPerMonth=0,conversationsPerMonth=0}={}){
 if(!Array.isArray(offers)||!Number.isInteger(seats)||seats<0||!Number.isFinite(actionsPerMonth)||actionsPerMonth<0||
  !Number.isFinite(conversationsPerMonth)||conversationsPerMonth<0)throw new TypeError("TCO_INPUT_INVALID");
 return offers.map(offer=>{
  const error=validateOffer(offer);if(error)throw new TypeError(error);
  let seatCost=0,usageCost=0,unitCost;
  if(offer.billing_unit==="USER_MONTH"){
   seatCost=offer.price*seats;
   if(offer.usage_model==="METERED_FLEX")
    usageCost=(actionsPerMonth*offer.credits_per_action/offer.credit_pack_size)*offer.credit_pack_price;
  }else if(offer.billing_unit==="CONVERSATION")usageCost=conversationsPerMonth*offer.price;
  else if(offer.billing_unit==="CREDITS_100K")
   usageCost=(actionsPerMonth*offer.credits_per_action/offer.credit_pack_size)*offer.credit_pack_price;
  unitCost=seatCost+usageCost;
  return Object.freeze({observation_id:offer.observation_id,competitor_id:offer.competitor_id,sku:offer.sku,
   currency:offer.currency,seats,actions_per_month:actionsPerMonth,conversations_per_month:conversationsPerMonth,
   seat_cost:Number(seatCost.toFixed(6)),usage_cost:Number(usageCost.toFixed(6)),
   estimated_monthly_total:Number(unitCost.toFixed(6)),estimate_only:true,
   excludes_base_crm_license:true,assumption:"Usage is prorated at the published unit rate; minimum pre-purchase blocks, discounts, taxes and contract terms are not modelled."});
 });
}

/**
 * Wave 6 — Telegram competitive-intelligence normalizer, snapshot comparator and TCO calculator.
 * All source verification is injected. MÕTLEMINE reviews evidence; this module never grants policy authority.
 */
export function createCompetitiveIntelligenceEngine({motlemineEngine,verifyTelegramSource,maxClaims=64,maxOffers=128}={}){
 if(!motlemineEngine||typeof motlemineEngine.analyze!=="function"||typeof verifyTelegramSource!=="function")
  throw new TypeError("TRUSTED_COMPETITIVE_INTEL_DEPENDENCIES_REQUIRED");
 if(!Number.isInteger(maxClaims)||maxClaims<1||maxClaims>128||!Number.isInteger(maxOffers)||maxOffers<1||maxOffers>256)
  throw new TypeError("COMPETITIVE_INTEL_LIMIT_INVALID");

 function analyze({signal,baseline=null}={}){
  const invalid=validateSignal(signal);
  if(invalid)return Object.freeze({status:"INPUT_INVALID",reason:invalid,policy_authority:false});
  if(signal.claims.length>maxClaims||signal.pricing_observations.length>maxOffers)
   return Object.freeze({status:"INPUT_INVALID",reason:"COMPETITIVE_INTEL_LIMIT_EXCEEDED",policy_authority:false});
  let telegramVerified=false;
  try{telegramVerified=verifyTelegramSource(Object.freeze(structuredClone(signal.telegram_source)))===true;}catch{telegramVerified=false;}
  const baselineMatches=!!baseline&&baseline.verified===true&&baseline.snapshot_id===signal.baseline_snapshot_id&&validId(baseline.snapshot_id);
  let reflection;
  try{
   reflection=motlemineEngine.analyze({analysis_id:signal.signal_id,evidence:signal.evidence,
    claims:signal.claims.map(c=>({claim_id:c.claim_id,statement:c.statement,depends_on:[],assessments:c.assessments}))});
  }catch{return Object.freeze({status:"REFLECTION_FAILED",reason:"MOTLEMINe_ENGINE_ERROR",policy_authority:false});}
  const reflectionClaims=new Map((reflection.claims??[]).map(c=>[c.claim_id,c]));
  const verifiedEvidence=new Set(reflection.verified_evidence_ids??[]);
  const comparisons=[];
  for(const c of signal.claims){
   const reviewed=reflectionClaims.get(c.claim_id);
   const evidenceSupported=telegramVerified&&reviewed?.status==="SUPPORTED";
   let comparison={status:"NOT_TEMPORAL"};
   if(TEMPORAL.has(c.kind)){
    if(!baselineMatches||c.baseline_ref!==baseline.snapshot_id)comparison={status:"BASELINE_MISSING"};
    else if(c.kind==="PRICE_CHANGE"){
     const current=signal.pricing_observations.find(o=>o.observation_id===c.observation_ref);
     comparison=current?comparePrice(current,baseline):{status:"CURRENT_PRICE_OBSERVATION_MISSING"};
     if(current&&!verifiedEvidence.has(current.source_evidence_id))comparison={status:"CURRENT_PRICE_EVIDENCE_UNVERIFIED"};
    }else if(c.kind==="RANKING_CHANGE")comparison=compareRanks(signal.ranking_snapshot,baseline);
    else if(c.kind==="NEW_ENTRANT"){
     const old=new Set(baseline.competitor_ids??[]);
     const added=signal.competitor_ids.filter(id=>!old.has(id));
     comparison={status:added.length?"DELTA_FOUND":"NO_CHANGE_FOUND",added};
    }else{
     if(c.baseline_value===null||c.current_value===null)comparison={status:"BASELINE_VALUE_MISSING"};
     else comparison={status:same(c.baseline_value,c.current_value)?"NO_CHANGE_FOUND":"DELTA_FOUND",
      previous_value:c.baseline_value,current_value:c.current_value};
    }
    if(comparison.status==="DELTA_FOUND")comparison={...comparison,status:evidenceSupported?"CHANGE_CONFIRMED":"CHANGE_UNVERIFIED"};
    else if(comparison.status==="NO_CHANGE_FOUND")comparison={...comparison,status:evidenceSupported?"CLAIM_NOT_REPRODUCED":"NO_CHANGE_UNVERIFIED"};
   }
   comparisons.push(Object.freeze({claim_id:c.claim_id,kind:c.kind,competitor_id:c.competitor_id,
    evidence_status:reviewed?.status??"MISSING",comparison}));
  }
  const trustedOffers=signal.pricing_observations.filter(o=>telegramVerified&&verifiedEvidence.has(o.source_evidence_id));
  const unavailableOffers=signal.pricing_observations.filter(o=>!trustedOffers.includes(o)).map(o=>o.observation_id);
  const mismatchedRecommendations=signal.recommendation_competitor_ids.filter(id=>!signal.competitor_ids.includes(id));
  const temporalResults=comparisons.filter(c=>TEMPORAL.has(c.kind));
  const unassessedChecks=signal.monitoring_checks.filter(kind=>{
   const rows=temporalResults.filter(c=>c.kind===kind);
   return rows.length===0||rows.some(c=>!["CHANGE_CONFIRMED","CLAIM_NOT_REPRODUCED"].includes(c.comparison.status));
  });
  const confirmedChanges=temporalResults.filter(c=>c.comparison.status==="CHANGE_CONFIRMED").length;
  const weeklyChangeStatus=confirmedChanges?(unassessedChecks.length?"CHANGES_CONFIRMED_WITH_GAPS":"CHANGES_CONFIRMED"):
   unassessedChecks.length?"INCOMPLETE_BASELINE_OR_EVIDENCE":"NO_CHANGES_CONFIRMED";
  const status=!telegramVerified?"SOURCE_UNVERIFIED":
   reflection.status==="REVIEW_REQUIRED"?"REVIEW_REQUIRED":
   reflection.status==="INPUT_INVALID"?"EVIDENCE_INPUT_INVALID":
   unavailableOffers.length||reflection.status==="EVIDENCE_INCOMPLETE"||unassessedChecks.length?"EVIDENCE_INCOMPLETE":"READY_FOR_REVIEW";
  const report={
   schema_version:"kratt-competitive-intel/v1",signal_id:signal.signal_id,status,policy_authority:false,
   received_at:signal.received_at,period:signal.period,primary_competitor:signal.primary_competitor,
   telegram_source_verified:telegramVerified,
   reflection_status:reflection.status,reflection_digest:reflection.report_digest??null,
   claims:comparisons,weekly_change_status:weeklyChangeStatus,confirmed_change_count:confirmedChanges,
   unassessed_checks:unassessedChecks,
   pricing:{verified_observations:trustedOffers,unverified_observation_ids:unavailableOffers},
   entity_reference_warnings:mismatchedRecommendations.map(id=>({code:"RECOMMENDATION_COMPETITOR_NOT_IN_SIGNAL_SCOPE",competitor_id:id})),
   recommendations:[
    "Persist each verified observation as an immutable, time-stamped competitor snapshot.",
    "Do not label a price, feature, ranking or governance item as a change without a comparable prior snapshot.",
    "Calculate TCO by billing unit and usage assumptions; never combine different currencies or incompatible SKUs.",
    "Route conflicting or insufficient evidence to human review; MÕTLEMINE has no policy or execution authority."
   ],
   tco:{available:trustedOffers.length>0,offer_count:trustedOffers.length},
  };
  const reportDigest="sha256:"+createHash("sha256").update(JSON.stringify(report),"utf8").digest("hex");
  return Object.freeze({...report,pricing:Object.freeze({...report.pricing,verified_observations:Object.freeze([...trustedOffers])}),
   entity_reference_warnings:Object.freeze(report.entity_reference_warnings),
   claims:Object.freeze(comparisons),unassessed_checks:Object.freeze(unassessedChecks),report_digest:reportDigest});
 }
 return Object.freeze({analyze,calculateTco:calculateMonthlyTco});
}
