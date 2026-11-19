import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramCompetitiveIngestion, verifyCompetitiveTelegramSecret } from "../src/telegram-competitive-ingestion.mjs";

const secret="local-wave7-webhook-secret";
const at="2026-11-18T18:00:00.000Z";
const offer={observation_id:"price-01",competitor_id:"salesforce",sku:"agentforce-user-license",price:5,
 currency:"USD",billing_unit:"USER_MONTH",usage_model:"INCLUDED",region:"US",source_evidence_id:"e-price",
 requires_flex_credits:false,credits_per_action:null,credit_pack_price:null,credit_pack_size:null,observed_at:at};
const claim={claim_id:"claim-price-01",claim_key:"agentforce-user-license",kind:"PRICING_CATALOG",competitor_id:"salesforce",
 statement:"Official price list includes an Agentforce user licence.",baseline_ref:null,observation_ref:null,
 baseline_value:null,current_value:null,assessments:[{evidence_id:"e-price",stance:"SUPPORTS",rationale_code:"official-pricing-page"}]};
const draft={period:{label:"7d",starts_at:"2026-11-11T00:00:00Z",ends_at:"2026-11-18T00:00:00Z"},
 primary_competitor:"salesforce",competitor_ids:["salesforce"],recommendation_competitor_ids:[],
 monitoring_checks:["PRICE_CHANGE"],claims:[claim],evidence:[{evidence_id:"e-price"}],
 pricing_observations:[offer],ranking_snapshot:null};
const report={
 status:"EVIDENCE_INCOMPLETE",telegram_source_verified:true,verified_evidence_ids:["e-price"],
 report_digest:"sha256:"+"a".repeat(64),weekly_change_status:"INCOMPLETE_BASELINE_OR_EVIDENCE",
 claims:[{claim_id:"claim-price-01",kind:"PRICING_CATALOG",competitor_id:"salesforce",evidence_status:"SUPPORTED"}],
 pricing:{verified_observations:[offer]}
};
const update=(id=71,chatId=-1001234567890)=>({update_id:id,channel_post:{
 message_id:901,date:1795020000,chat:{id:chatId,type:"channel",username:"bourne_updates"},text:"Salesforce Agentforce pricing: $5 per user."
}});
function makeStore({baseline=null,commitResults=[]}={}){
 const state={claims:[],commits:[],released:[],baseline,commitResults:[...commitResults]};
 return {state,
  async claimUpdate(args){state.claims.push(args);return{status:"CLAIMED",leaseToken:"competitive-lease:00000000-0000-4000-8000-000000000001"};},
  async getLatestSnapshot(){return state.baseline;},
  async commitSnapshot(args){state.commits.push(args);return state.commitResults.shift()??{ok:true,snapshotId:args.snapshot.snapshot_id};},
  async releaseUpdate(args){state.released.push(args);return true;}
 };
}
function makeIngest({store=makeStore(),engine,parseSignal=async()=>draft,overrides={}}={}){
 const reports=[];
 const actualEngine=engine??{analyze:({signal,baseline})=>{reports.push({signal,baseline});return report;}};
 const service=createTelegramCompetitiveIngestion({
  webhookSecret:secret,botId:"jason-bourne",allowedChannelIds:["-1001234567890"],
  parseSignal,engine:actualEngine,store,clock:()=>new Date(at),makeSnapshotId:()=>"snapshot-wave7-0001",
  ...overrides
 });
 return {service,store,reports};
}

test("Telegram webhook secret uses constant-time byte comparison semantics",()=>{
 assert.equal(verifyCompetitiveTelegramSecret(secret,secret),true);
 assert.equal(verifyCompetitiveTelegramSecret(secret,"different-secret"),false);
 assert.equal(verifyCompetitiveTelegramSecret(undefined,secret),false);
 assert.equal(verifyCompetitiveTelegramSecret("é","a"),false);
});

test("wrong webhook secret is denied before update claim or parsing",async()=>{
 const {service,store}=makeIngest();
 const result=await service.ingest({update:update(),receivedSecret:"wrong"});
 assert.equal(result.status,"DENY");
 assert.equal(store.state.claims.length,0);
});

test("private messages and non-allowlisted channels are rejected",async()=>{
 const {service,store}=makeIngest();
 const privateMessage={update_id:72,message:{message_id:1,date:1795020000,chat:{id:123,type:"private"},text:"hello"}};
 const result=await service.ingest({update:privateMessage,receivedSecret:secret});
 assert.equal(result.reason,"TELEGRAM_CHANNEL_POST_REQUIRED");
 const blocked=await service.ingest({update:update(73,-1009999999999),receivedSecret:secret});
 assert.equal(blocked.reason,"TELEGRAM_CHANNEL_NOT_ALLOWLISTED");
 assert.equal(store.state.claims.length,0);
});

test("authenticated allowlisted channel posts become evidence-gated snapshots",async()=>{
 const {service,store,reports}=makeIngest();
 const result=await service.ingest({update:update(),receivedSecret:secret});
 assert.equal(result.status,"OK");
 assert.equal(result.snapshotId,"snapshot-wave7-0001");
 assert.equal(store.state.commits.length,1);
 assert.equal(reports[0].signal.telegram_source.channel_id,"telegram-channel-n1001234567890");
 assert.equal(reports[0].signal.telegram_source.message_id,"telegram-message-901");
 assert.equal(reports[0].signal.telegram_source.permalink,"https://t.me/bourne_updates/901");
 assert.equal(store.state.commits[0].snapshot.competitor_id,"salesforce");
 assert.deepEqual(store.state.commits[0].snapshot.pricing_observations,[offer]);
 assert.deepEqual(store.state.commits[0].snapshot.competitor_ids,["salesforce"]);
 assert.equal(store.state.commits[0].snapshot.source.update_id,71);
 assert.equal(store.state.commits[0].expectedPreviousSnapshotId,null);
});

test("parser cannot override Telegram provenance or the trusted baseline reference",async()=>{
 const baseline={snapshot_id:"snapshot-prior",verified:true,competitor_id:"salesforce",competitor_ids:["salesforce"],
  pricing_observations:[offer],ranking_snapshot:null};
 const malicious={...draft,signal_id:"attacker-controlled",received_at:"2000-01-01T00:00:00Z",
  telegram_source:{channel_id:"forged",message_id:"forged",source_id:"forged",source_type:"telegram",
   observed_at:at,permalink:null},baseline_snapshot_id:"forged",
  claims:[{...claim,baseline_ref:"attacker-controlled"}]};
 const {service,store,reports}=makeIngest({store:makeStore({baseline}),parseSignal:async()=>malicious});
 const result=await service.ingest({update:update(74),receivedSecret:secret});
 assert.equal(result.status,"OK");
 assert.equal(reports[0].signal.signal_id,"telegram-update-74");
 assert.equal(reports[0].signal.received_at,at);
 assert.equal(reports[0].signal.telegram_source.channel_id,"telegram-channel-n1001234567890");
 assert.equal(reports[0].signal.baseline_snapshot_id,"snapshot-prior");
 assert.equal(reports[0].signal.claims[0].baseline_ref,null);
 assert.equal(store.state.commits[0].expectedPreviousSnapshotId,"snapshot-prior");
});

test("unverified evidence is never copied into the durable competitor baseline",async()=>{
 const unsafeReport={...report,verified_evidence_ids:[],pricing:{verified_observations:[]},claims:[]};
 const {service,store}=makeIngest({engine:{analyze:()=>unsafeReport}});
 const result=await service.ingest({update:update(75),receivedSecret:secret});
 assert.equal(result.status,"OK");
 assert.deepEqual(store.state.commits[0].snapshot.pricing_observations,[]);
 assert.deepEqual(store.state.commits[0].snapshot.competitor_ids,[]);
});

test("concurrent snapshot head movement triggers a re-analysis against the new baseline",async()=>{
 const first={snapshot_id:"snapshot-prior-1",verified:true,competitor_id:"salesforce",competitor_ids:[],pricing_observations:[],ranking_snapshot:null};
 const second={snapshot_id:"snapshot-prior-2",verified:true,competitor_id:"salesforce",competitor_ids:[],pricing_observations:[],ranking_snapshot:null};
 const store=makeStore({baseline:first,commitResults:[{ok:false,reason:"BASELINE_CHANGED"},{ok:true}]});
 let calls=0;
 store.getLatestSnapshot=async()=>{calls++;return calls===1?first:second;};
 const reports=[];
 const engine={analyze:({signal,baseline})=>{reports.push({signal,baseline});return report;}};
 const {service}=makeIngest({store,engine});
 const result=await service.ingest({update:update(76),receivedSecret:secret});
 assert.equal(result.status,"OK");
 assert.equal(reports.length,2);
 assert.equal(reports[0].signal.baseline_snapshot_id,"snapshot-prior-1");
 assert.equal(reports[1].signal.baseline_snapshot_id,"snapshot-prior-2");
});

test("invalid parser and source failures release the durable lease without snapshot",async()=>{
 const store=makeStore();
 const {service}=makeIngest({store,parseSignal:async()=>({primary_competitor:"salesforce"})});
 const result=await service.ingest({update:update(77),receivedSecret:secret});
 assert.equal(result.status,"ERROR");
 assert.equal(store.state.commits.length,0);
 assert.equal(store.state.released.length,1);
});

test("oversized and non-text updates fail closed before persistence",async()=>{
 const {service,store}=makeIngest({overrides:{maxTextBytes:256}});
 const huge=update(78);huge.channel_post.text="x".repeat(400);
 const result=await service.ingest({update:huge,receivedSecret:secret});
 assert.equal(result.reason,"TELEGRAM_MESSAGE_TOO_LARGE");
 assert.equal(store.state.claims.length,0);
});

test("feature and governance baselines are sourced only from the prior verified snapshot",async()=>{
 const featureClaim={...claim,claim_id:"feature-01",claim_key:"agentforce-voice",kind:"FEATURE_CHANGE",
  baseline_value:"attacker-provided-old-value",current_value:"enabled"};
 const featureDraft={...draft,monitoring_checks:["FEATURE_CHANGE"],claims:[featureClaim]};
 const prior={snapshot_id:"snapshot-prior-feature",verified:true,competitor_id:"salesforce",competitor_ids:["salesforce"],
  pricing_observations:[],ranking_snapshot:null,
  claim_values:[{claim_key:"agentforce-voice",kind:"FEATURE_CHANGE",competitor_id:"salesforce",value:"disabled",evidence_ids:["e-price"]}]};
 const featureReport={...report,claims:[{claim_id:"feature-01",kind:"FEATURE_CHANGE",competitor_id:"salesforce",evidence_status:"SUPPORTED"}]};
 const store=makeStore({baseline:prior});
 const captured=[];
 const {service}=makeIngest({store,parseSignal:async()=>featureDraft,engine:{analyze:({signal,baseline})=>{captured.push({signal,baseline});return featureReport;}}});
 const result=await service.ingest({update:update(79),receivedSecret:secret});
 assert.equal(result.status,"OK");
 assert.equal(captured[0].signal.claims[0].baseline_value,"disabled");
 assert.equal(captured[0].signal.claims[0].baseline_ref,"snapshot-prior-feature");
 assert.deepEqual(store.state.commits[0].snapshot.claim_values,[{
  claim_key:"agentforce-voice",kind:"FEATURE_CHANGE",competitor_id:"salesforce",value:"enabled",evidence_ids:["e-price"]
 }]);
});

test("non-canonical accessors and impossible Telegram dates are rejected before an inbox lease",async()=>{
 const {service,store}=makeIngest();
 const impossible=update(80);impossible.channel_post.date=Number.MAX_SAFE_INTEGER;
 const badDate=await service.ingest({update:impossible,receivedSecret:secret});
 assert.equal(badDate.reason,"TELEGRAM_MESSAGE_METADATA_INVALID");
 const accessor=update(81);
 Object.defineProperty(accessor,"update_id",{enumerable:true,get(){throw new Error("should not execute");}});
 const badShape=await service.ingest({update:accessor,receivedSecret:secret});
 assert.equal(badShape.reason,"TELEGRAM_UPDATE_CANONICALIZATION_FAILED");
 assert.equal(store.state.claims.length,0);
});
