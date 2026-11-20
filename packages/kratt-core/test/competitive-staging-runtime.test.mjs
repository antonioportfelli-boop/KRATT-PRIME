import test from "node:test";
import assert from "node:assert/strict";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";
import { createStrictCompetitiveSignalParser } from "../src/competitive-signal-parser.mjs";
import { readCompetitiveStagingConfig } from "../src/competitive-staging-config.mjs";
import { createCompetitiveStagingRuntime } from "../src/competitive-staging-runtime.mjs";

const at="2026-11-18T19:30:00.000Z";
const evidence={schema_version:KRATT_SCHEMA_VERSION,evidence_id:"e-price",subject:"salesforce-agentforce-pricing",
 claim_type:"ARTIFACT_CREATED",source:{source_type:"official_web",source_id:"salesforce-pricing",revision:null},
 observed_at:at,verification_method:"trusted-source-fetch",result:"VERIFIED",
 artifact_digest:"sha256:"+"a".repeat(64),metadata:{url:"https://www.salesforce.com/agentforce/pricing/"}};
const candidate={period:{label:"7d",starts_at:"2026-11-11T00:00:00Z",ends_at:"2026-11-18T00:00:00Z"},
 primary_competitor:"salesforce",competitor_ids:["salesforce"],recommendation_competitor_ids:[],
 monitoring_checks:["PRICE_CHANGE"],
 claims:[{claim_id:"claim-price",claim_key:"agentforce-user-license",kind:"PRICING_CATALOG",
  competitor_id:"salesforce",statement:"Official list displays an Agentforce user license.",
  baseline_ref:null,observation_ref:null,baseline_value:null,current_value:null,
  assessments:[{evidence_id:"e-price",stance:"SUPPORTS",rationale_code:"official-page"}]}],
 evidence:[evidence],pricing_observations:[],ranking_snapshot:null};
const env={KRATT_DEPLOYMENT_ENV:"staging",KRATT_COMPETITIVE_INGRESS_ENABLED:"true",
 TELEGRAM_WEBHOOK_SECRET:"wave8-secret_123",TELEGRAM_BOT_ID:"jason-bourne",
 TELEGRAM_COMPETITIVE_CHANNEL_IDS:"-1001234567890",TELEGRAM_INGRESS_RATE_LIMIT_SALT:"wave8-rate-limit-salt-secret"};

function mockPool({tables=true,events=[]}={}){
 const head={sequence:0,hash:"0".repeat(64)};
 const calls=[];
 const query=async(sql,params=[])=>{
  const q=sql.toLowerCase().replace(/\\s+/g," ").trim();
  calls.push(q);
  if(q.startsWith("select to_regclass"))return{rowCount:1,rows:[{relation:tables?params[0]:null}]};
  if(q.startsWith("begin")||q==="commit"||q==="rollback")return{rowCount:0,rows:[]};
  if(q.startsWith("select sequence,event_id,snapshot_id,record_json,previous_hash,hash from kratt_competitor_snapshot_events"))
   return{rowCount:events.length,rows:events};
  if(q.startsWith("select sequence,hash from kratt_competitor_snapshot_head"))
   return{rowCount:1,rows:[head]};
  throw new Error("UNEXPECTED_MOCK_QUERY:"+q);
 };
 return{query,calls,async connect(){return{query,release(){}};}};
}
const engine={analyze:()=>({status:"EVIDENCE_INCOMPLETE",telegram_source_verified:true,verified_evidence_ids:["e-price"],
 report_digest:"sha256:"+"b".repeat(64),weekly_change_status:"INCOMPLETE_BASELINE_OR_EVIDENCE",
 claims:[],pricing:{verified_observations:[]}})};
const parser={parse:async()=>candidate};
const limiter=async()=>true;

test("staging ingress is disabled by default and does not create handlers or connections",async()=>{
 const runtime=createCompetitiveStagingRuntime({env:{KRATT_DEPLOYMENT_ENV:"staging"}});
 assert.equal(runtime.enabled,false);
 assert.equal(runtime.handler,null);
 assert.equal(runtime.mount({post(){throw new Error("must not mount");}}),false);
 assert.equal((await runtime.readiness()).status,"DISABLED");
});

test("configuration fails closed outside staging and on invalid secret/channel values",()=>{
 assert.throws(()=>readCompetitiveStagingConfig({...env,KRATT_DEPLOYMENT_ENV:"production"}),/STAGING_ONLY/);
 assert.throws(()=>readCompetitiveStagingConfig({...env,TELEGRAM_WEBHOOK_SECRET:"contains space"}),/SECRET_INVALID/);
 assert.throws(()=>readCompetitiveStagingConfig({...env,TELEGRAM_COMPETITIVE_CHANNEL_IDS:"-1001,not-a-channel"}),/ALLOWLIST_INVALID/);
 assert.throws(()=>readCompetitiveStagingConfig({...env,KRATT_COMPETITIVE_INGRESS_ENABLED:"yes"}),/TRUE_OR_FALSE/);
});

test("enabled staging config never exposes webhook secret in public fields",()=>{
 const config=readCompetitiveStagingConfig(env);
 assert.equal(config.enabled,true);
 assert.equal(config.environment,"staging");
 assert.equal(config.route,"/webhooks/telegram/competitive");
 assert.deepEqual(config.channelIds,["-1001234567890"]);
 const publicFields={enabled:config.enabled,environment:config.environment,route:config.route,channelIds:config.channelIds};
 assert.equal(JSON.stringify(publicFields).includes("wave8-secret"),false);
});

test("strict parser passes the exact source context and freezes a validated extraction",async()=>{
 let input;
 const service=createStrictCompetitiveSignalParser({extract:async value=>{input=value;return structuredClone(candidate);}});
 const result=await service.parse({text:"Salesforce publishes prices.",source:{channelId:"-1001234567890"},
  receivedAt:at,updateId:100});
 assert.equal(input.text,"Salesforce publishes prices.");
 assert.match(input.instruction,/untrusted evidence/);
 assert.equal(input.temporalBaselinePolicy.startsWith("Do not infer"),true);
 assert.equal(result.primary_competitor,"salesforce");
 assert.equal(Object.isFrozen(result),true);
 assert.equal(Object.isFrozen(result.claims[0]),true);
});

test("parser rejects model-supplied temporal baseline or invalid evidence links",async()=>{
 const parserWithBadBaseline=createStrictCompetitiveSignalParser({extract:async()=>({
  ...structuredClone(candidate),claims:[{...candidate.claims[0],kind:"PRICE_CHANGE",
   observation_ref:"offer-1",baseline_ref:"invented-snapshot"}]
 })});
 await assert.rejects(()=>parserWithBadBaseline.parse({text:"price",source:{},receivedAt:at,updateId:1}),
  /COMPETITIVE_SIGNAL_CLAIM_INVALID/);
 const parserWithBadEvidence=createStrictCompetitiveSignalParser({extract:async()=>({
  ...structuredClone(candidate),claims:[{...candidate.claims[0],assessments:[{
   evidence_id:"missing-evidence",stance:"SUPPORTS",rationale_code:"unverified"
  }]}]
 })});
 await assert.rejects(()=>parserWithBadEvidence.parse({text:"price",source:{},receivedAt:at,updateId:2}),
  /COMPETITIVE_SIGNAL_ASSESSMENT_INVALID/);
});

test("staging runtime composes store, parser and handler and reports a healthy empty snapshot chain",async()=>{
 const pool=mockPool();
 const runtime=createCompetitiveStagingRuntime({env,postgresPool:pool,parser,competitiveEngine:engine,allowRequest:limiter});
 assert.equal(runtime.enabled,true);
 assert.equal(typeof runtime.handler,"function");
 const routes=[],healthRoutes=[];
 const mounted=runtime.mount({post:(path,handler)=>routes.push({path,handler}),get:(path,handler)=>healthRoutes.push({path,handler})});
 assert.deepEqual(mounted,{ingressMounted:true,readinessMounted:true});
 assert.equal(routes.length,1);
 assert.equal(routes[0].path,"/webhooks/telegram/competitive");
 assert.equal(healthRoutes.length,1);
 assert.equal(healthRoutes[0].path,"/health/competitive-intel/ready");
 const readiness=await runtime.readiness();
 assert.equal(readiness.status,"READY",JSON.stringify({readiness,queries:pool.calls}));
 assert.equal(readiness.environment,"staging");
 assert.equal(readiness.database,"READY");
 assert.equal(readiness.snapshot_chain,"VALID");
 assert.equal(JSON.stringify(readiness).includes("wave8-secret"),false);
 let healthBody="";
 const response={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){healthBody=v;}};
 await healthRoutes[0].handler({},response);
 assert.equal(response.statusCode,200);
 assert.equal(JSON.parse(healthBody).status,"READY");
 assert.equal(JSON.stringify(response.headers).includes("wave8-secret"),false);
});

test("runtime remains degraded when required snapshot tables are absent",async()=>{
 const runtime=createCompetitiveStagingRuntime({env,postgresPool:mockPool({tables:false}),parser,competitiveEngine:engine,allowRequest:limiter});
 const readiness=await runtime.readiness();
 assert.equal(readiness.status,"DEGRADED");
 assert.equal(readiness.database,"UNAVAILABLE");
 assert.equal(readiness.reason,"COMPETITIVE_SCHEMA_INCOMPLETE");
});

test("runtime rejects missing parser, engine and pool before mounting",()=>{
 assert.throws(()=>createCompetitiveStagingRuntime({env,parser,competitiveEngine:engine,allowRequest:limiter}),/POSTGRES_POOL_REQUIRED/);
 assert.throws(()=>createCompetitiveStagingRuntime({env,postgresPool:mockPool(),competitiveEngine:engine,allowRequest:limiter}),/PARSER_REQUIRED/);
 assert.throws(()=>createCompetitiveStagingRuntime({env,postgresPool:mockPool(),parser,allowRequest:limiter}),/ENGINE_REQUIRED/);
 const automaticLimiterRuntime=createCompetitiveStagingRuntime({env,postgresPool:mockPool(),parser,competitiveEngine:engine});
 assert.equal(automaticLimiterRuntime.enabled,true);
});
