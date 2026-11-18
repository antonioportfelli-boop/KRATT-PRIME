import test from "node:test";
import assert from "node:assert/strict";
import { createCompetitiveIntelligenceEngine, calculateMonthlyTco } from "../src/competitive-intelligence-engine.mjs";
import { createMotlemineEngine } from "../src/motlemine-engine.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";

const at="2026-11-18T17:00:00.000Z";
const evidence=(id,source="salesforce-pricing",result="VERIFIED")=>({
 schema_version:KRATT_SCHEMA_VERSION,evidence_id:id,subject:"salesforce-agentforce-pricing",claim_type:"ARTIFACT_CREATED",
 source:{source_type:"official_web",source_id:source,revision:null},observed_at:at,
 verification_method:"trusted-source-fetch",result,artifact_digest:"sha256:"+"a".repeat(64),
 metadata:{url:"https://www.salesforce.com/agentforce/pricing/"}
});
const assessment=(evidence_id)=>({evidence_id,stance:"SUPPORTS",rationale_code:"official-price-list"});
const offer=(id,sku,price,currency="USD",billing_unit="USER_MONTH",usage_model="INCLUDED",overrides={})=>({
 observation_id:id,competitor_id:"salesforce",sku,price,currency,billing_unit,usage_model,region:"US",
 source_evidence_id:"price-evidence",requires_flex_credits:false,credits_per_action:null,
 credit_pack_price:null,credit_pack_size:null,observed_at:at,...overrides
});
const claim=(id,kind,options={})=>({claim_id:id,kind,competitor_id:"salesforce",statement:"Published Agentforce pricing is visible.",
 baseline_ref:null,observation_ref:null,baseline_value:null,current_value:null,
 assessments:[assessment("price-evidence")],...options});
const signal=overrides=>({
 signal_id:"telegram-signal-01",received_at:at,period:{label:"7d",starts_at:"2026-11-11T00:00:00Z",ends_at:"2026-11-18T00:00:00Z"},
 telegram_source:{channel_id:"jason-bourne",message_id:"message-901",source_id:"telegram-news",source_type:"telegram",observed_at:at,permalink:"https://t.me/example/901"},
 primary_competitor:"salesforce",competitor_ids:["salesforce"],recommendation_competitor_ids:["microsoft"],
 monitoring_checks:["PRICE_CHANGE","RANKING_CHANGE","NEW_ENTRANT","FEATURE_CHANGE","GOVERNANCE_CHANGE"],
 baseline_snapshot_id:null,
 claims:[claim("catalog-claim","PRICING_CATALOG")],evidence:[evidence("price-evidence")],
 pricing_observations:[offer("coworker-us","agentforce-coworker-user-license",50)],
 ranking_snapshot:{universe_id:"agent-platforms-top10",observed_at:at,entries:[{competitor_id:"salesforce",rank:1}]},
 ...overrides
});
function makeEngine({sourceVerified=true}={}){
 const motlemine=createMotlemineEngine({verifyEvidence:e=>e.result==="VERIFIED",minIndependentSources:1});
 return createCompetitiveIntelligenceEngine({motlemineEngine:motlemine,verifyTelegramSource:()=>sourceVerified});
}

test("verified Telegram pricing catalogue is separated from a verified price change",()=>{
 const result=makeEngine().analyze({signal:signal()});
 assert.equal(result.status,"EVIDENCE_INCOMPLETE");
 assert.equal(result.pricing.verified_observations.length,1);
 assert.equal(result.weekly_change_status,"INCOMPLETE_BASELINE_OR_EVIDENCE");
 assert.deepEqual(result.unassessed_checks,["PRICE_CHANGE","RANKING_CHANGE","NEW_ENTRANT","FEATURE_CHANGE","GOVERNANCE_CHANGE"]);
 assert.equal(result.policy_authority,false);
 assert.equal(result.entity_reference_warnings[0].code,"RECOMMENDATION_COMPETITOR_NOT_IN_SIGNAL_SCOPE");
});

test("a price change is confirmed only against a same-SKU currency and unit baseline",()=>{
 const current=offer("coworker-us","agentforce-coworker-user-license",50);
 const s=signal({baseline_snapshot_id:"snapshot-prior",monitoring_checks:["PRICE_CHANGE"],
  claims:[claim("price-change","PRICE_CHANGE",{baseline_ref:"snapshot-prior",observation_ref:"coworker-us"})]});
 const baseline={verified:true,snapshot_id:"snapshot-prior",competitor_ids:["salesforce"],pricing_observations:[{...current,price:45,observed_at:"2026-11-10T12:00:00Z"}]};
 const result=makeEngine().analyze({signal:s,baseline});
 assert.equal(result.claims[0].comparison.status,"CHANGE_CONFIRMED");
 assert.equal(result.claims[0].comparison.absolute_delta,5);
 assert.equal(result.weekly_change_status,"CHANGES_CONFIRMED");
});

test("currency mismatch cannot create a price-change conclusion",()=>{
 const current=offer("coworker-eu","agentforce-coworker-user-license",50,"EUR");
 const s=signal({baseline_snapshot_id:"snapshot-prior",monitoring_checks:["PRICE_CHANGE"],
  claims:[claim("price-change","PRICE_CHANGE",{baseline_ref:"snapshot-prior",observation_ref:"coworker-eu"})],
  pricing_observations:[current]});
 const baseline={verified:true,snapshot_id:"snapshot-prior",competitor_ids:["salesforce"],pricing_observations:[{...current,currency:"USD",price:45,observed_at:"2026-11-10T12:00:00Z"}]};
 const result=makeEngine().analyze({signal:s,baseline});
 assert.equal(result.claims[0].comparison.status,"COMPARABLE_BASELINE_MISSING");
 assert.equal(result.weekly_change_status,"INCOMPLETE_BASELINE_OR_EVIDENCE");
});

test("ranking claims without a prior snapshot remain unconfirmed",()=>{
 const s=signal({baseline_snapshot_id:null,monitoring_checks:["RANKING_CHANGE"],
  claims:[claim("rank-change","RANKING_CHANGE")]});
 const result=makeEngine().analyze({signal:s});
 assert.equal(result.claims[0].comparison.status,"BASELINE_MISSING");
 assert.equal(result.weekly_change_status,"INCOMPLETE_BASELINE_OR_EVIDENCE");
});

test("unverified Telegram source prevents a pricing observation from entering the trusted catalogue",()=>{
 const result=makeEngine({sourceVerified:false}).analyze({signal:signal()});
 assert.equal(result.status,"SOURCE_UNVERIFIED");
 assert.equal(result.pricing.verified_observations.length,0);
 assert.deepEqual(result.pricing.unverified_observation_ids,["coworker-us"]);
});

test("TCO calculator keeps seat and usage components separate",()=>{
 const metered=offer("user-license","agentforce-user-license",5,"USD","USER_MONTH","METERED_FLEX",{
  requires_flex_credits:true,credits_per_action:20,credit_pack_price:500,credit_pack_size:100000
 });
 const results=calculateMonthlyTco({offers:[metered],seats:10,actionsPerMonth:1000});
 assert.equal(results[0].seat_cost,50);
 assert.equal(results[0].usage_cost,100);
 assert.equal(results[0].estimated_monthly_total,150);
 assert.equal(results[0].excludes_base_crm_license,true);
});

test("invalid signal structures fail closed",()=>{
 const s=signal();s.pricing_observations[0].currency="US";
 const result=makeEngine().analyze({signal:s});
 assert.equal(result.status,"INPUT_INVALID");
 assert.equal(result.reason,"PRICING_OBSERVATION_VALUE_INVALID");
});

test("same-source or unavailable evidence cannot support a pricing catalogue claim",()=>{
 const s=signal({evidence:[evidence("price-evidence","salesforce-pricing","UNAVAILABLE")]});
 const result=makeEngine().analyze({signal:s});
 assert.equal(result.status,"EVIDENCE_INCOMPLETE");
 assert.equal(result.pricing.verified_observations.length,0);
});
