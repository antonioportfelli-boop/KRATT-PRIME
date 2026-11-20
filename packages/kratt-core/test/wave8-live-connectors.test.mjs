import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import {
 loadWave8Config,createTelegramSourceVerifier,createTrustedSourceCapture,
 createOpenAiCompetitiveSignalParser,createTelegramBotApiAdmin,createInMemoryTelegramRateLimiter,
 createPostgresPoolFromConfig,
} from "../../kratt-orchestrator/src/wave8-live-connectors.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";

const token="123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const at="2026-11-19T10:00:00.000Z";
function env(overrides={}){
 return {
  APP_ENV:"staging",HOST:"127.0.0.1",PORT:"8787",
  TELEGRAM_BOT_TOKEN:token,TELEGRAM_WEBHOOK_SECRET:"a".repeat(48),TELEGRAM_BOT_ID:"123456",
  TELEGRAM_ALLOWED_CHANNEL_IDS:"-1001234567890",TELEGRAM_RATE_LIMIT_SALT:"s".repeat(48),
  DATABASE_URL:"postgresql://kratt:secret@db.example.com:5432/kratt_staging",
  OPENAI_API_KEY:"sk-test-"+("k".repeat(32)),OPENAI_MODEL:"gpt-test-model",
  WEBHOOK_PUBLIC_URL:"https://staging.example.com/webhooks/telegram/competitive",
  COMPETITOR_SOURCE_ALLOWLIST:"salesforce.com,microsoft.com",MIN_INDEPENDENT_SOURCES:"2",
  WAVE8_ALLOW_TELEGRAM_TEXT_TO_OPENAI:"true",WAVE8_ENABLE_WEBHOOK_WRITES:"false",
  ...overrides,
 };
}
function response(payload,{ok=true,status=200,headers={}}={}){
 const data=Buffer.from(typeof payload==="string"?payload:JSON.stringify(payload));
 return {ok,status,headers:{get:key=>headers[key.toLowerCase()]??null},json:async()=>payload,
  body:new ReadableStream({start(controller){controller.enqueue(data);controller.close();}}),
  arrayBuffer:async()=>data};
}

test("Wave 8 config requires HTTPS, DB TLS-compatible URL and explicit model-processing consent",()=>{
 const config=loadWave8Config(env());
 assert.equal(config.webhookPath,"/webhooks/telegram/competitive");
 assert.equal(config.telegramBotId,"123456");
 assert.equal(config.allowOpenAiProcessing,true);
 assert.equal(config.databaseUrl.hostname,"db.example.com");
 assert.equal(config.enableWebhookWrites,false);
 assert.equal(config.telegramIngressRateLimit,30);
 assert.equal(config.telegramIngressRateWindowMs,60_000);
 assert.throws(()=>loadWave8Config(env({WAVE8_ALLOW_TELEGRAM_TEXT_TO_OPENAI:"false"})),/WAVE8_CONFIG_INVALID/);
 assert.throws(()=>loadWave8Config(env({WEBHOOK_PUBLIC_URL:"http://staging.example.com/hook"})),/WAVE8_CONFIG_INVALID/);
 assert.throws(()=>loadWave8Config(env({DATABASE_URL:"postgresql://kratt:secret@db.example.com/kratt?sslmode=disable"})),/WAVE8_CONFIG_INVALID/);
 assert.throws(()=>loadWave8Config(env({TELEGRAM_INGRESS_RATE_LIMIT:"0"})),/WAVE8_CONFIG_INVALID/);
 assert.throws(()=>loadWave8Config(env({TELEGRAM_INGRESS_RATE_LIMIT:"10001"})),/WAVE8_CONFIG_INVALID/);
 assert.throws(()=>loadWave8Config(env({TELEGRAM_INGRESS_RATE_WINDOW_MS:"999"})),/WAVE8_CONFIG_INVALID/);
});

test("Telegram source verifier binds message lineage to an allowlisted channel",()=>{
 const verify=createTelegramSourceVerifier(["-1001234567890"]);
 assert.equal(verify({
  channel_id:"telegram-channel-n1001234567890",message_id:"telegram-message-901",
  source_id:"telegram-source-n1001234567890",source_type:"telegram",
  observed_at:at,permalink:"https://t.me/bourne_updates/901",
 }),true);
 assert.equal(verify({
  channel_id:"telegram-channel-n999",message_id:"telegram-message-901",
  source_id:"telegram-source-n999",source_type:"telegram",observed_at:at,permalink:null,
 }),false);
});

test("trusted source capture hashes only allowlisted HTTPS pages and verifies evidence",async()=>{
 const page="<html><title>Agentforce pricing</title></html>";
 const fetchCalls=[];
 const capture=createTrustedSourceCapture({
  allowedHosts:["salesforce.com"],now:()=>new Date(at),
  fetchImpl:async(url,options)=>{fetchCalls.push({url,options});return response(page,{headers:{"content-length":String(Buffer.byteLength(page))}});},
 });
 const evidence=await capture.capture({
  evidence_id:"e-salesforce",subject:"salesforce-agentforce",claim_type:"ARTIFACT_CREATED",
  source_id:"salesforce-pricing-2026",url:"https://www.salesforce.com/agentforce/pricing/",title:"salesforce-pricing-page",
 });
 assert.equal(evidence.schema_version,KRATT_SCHEMA_VERSION);
 assert.equal(evidence.result,"VERIFIED");
 assert.equal(capture.verifyEvidence(evidence),true);
 assert.equal(fetchCalls[0].options.redirect,"error");
 await assert.rejects(()=>capture.capture({
  evidence_id:"e-bad",subject:"salesforce-agentforce",claim_type:"ARTIFACT_CREATED",
  source_id:"bad-source",url:"https://attacker.example/pricing",title:"bad-page",
 }),/SOURCE_CANDIDATE_REJECTED/);
 assert.equal(fetchCalls.length,1);
});

test("source capture rejects overlarge sources",async()=>{
 const capture=createTrustedSourceCapture({allowedHosts:["salesforce.com"],maxBytes:8,
  fetchImpl:async()=>response("123456789",{headers:{"content-length":"9"}})});
 await assert.rejects(()=>capture.capture({
  evidence_id:"e-large",subject:"salesforce-agentforce",claim_type:"ARTIFACT_CREATED",
  source_id:"salesforce-page",url:"https://salesforce.com/pricing",title:"pricing-page",
 }),/SOURCE_RESPONSE_TOO_LARGE/);
});

test("OpenAI Responses parser returns trusted evidence-backed Wave 6 draft and sends no Telegram metadata",async()=>{
 const captured=[];
 const evidence={
  schema_version:KRATT_SCHEMA_VERSION,evidence_id:"e-salesforce",subject:"salesforce-agentforce",
  claim_type:"ARTIFACT_CREATED",source:{source_type:"official_web",source_id:"salesforce-official",revision:null},
  observed_at:at,verification_method:"https-source-content-sha256-v1",result:"VERIFIED",
  artifact_digest:"sha256:"+"a".repeat(64),metadata:{url:"https://salesforce.com/pricing",title:"pricing-page"},
 };
 const structured={
  primary_competitor:"salesforce",competitor_ids:["salesforce"],recommendation_competitor_ids:[],
  monitoring_checks:["PRICE_CHANGE"],source_candidates:[{
   evidence_id:"e-salesforce",subject:"salesforce-agentforce",claim_type:"ARTIFACT_CREATED",
   source_id:"salesforce-official",url:"https://salesforce.com/pricing",title:"pricing-page"
  }],
  claims:[{claim_id:"claim-price",claim_key:"agentforce-user",kind:"PRICING_CATALOG",competitor_id:"salesforce",
   statement:"Salesforce publishes a user license price.",observation_ref:null,baseline_value:null,current_value:null,
   assessments:[{evidence_id:"e-salesforce",stance:"SUPPORTS",rationale_code:"official-pricing"}]}],
  pricing_observations:[{observation_id:"offer-5",competitor_id:"salesforce",sku:"agentforce-user",
   price:5,currency:"USD",billing_unit:"USER_MONTH",usage_model:"INCLUDED",region:"US",
   source_evidence_id:"e-salesforce",requires_flex_credits:false,credits_per_action:null,credit_pack_price:null,credit_pack_size:null}],
  ranking_snapshot:null,
 };
 const parser=createOpenAiCompetitiveSignalParser({
  apiKey:"sk-test-"+("x".repeat(32)),model:"gpt-test-model",
  sourceCapture:{capture:async candidate=>{captured.push(candidate);return evidence;}},
  fetchImpl:async(url,options)=>{
   assert.equal(url,"https://api.openai.com/v1/responses");
   const body=JSON.parse(options.body);
   assert.equal(body.store,false);
   assert.deepEqual(body.tools,[]);
   assert.match(body.input,/telegram_text/);
   assert.doesNotMatch(body.input,/telegram-channel|telegram-message|telegram-source|update_id/);
   assert.equal(body.text.format.strict,true);
   return response({status:"completed",output_text:JSON.stringify(structured)});
  },
  now:()=>new Date(at),
 });
 const result=await parser({text:"Salesforce offers an Agentforce user license for $5.",source:{
  source:{channel_id:"secret-channel",message_id:"secret-message",source_id:"secret-source",observed_at:at,permalink:null}
 },receivedAt:at,updateId:901});
 assert.equal(result.period.label,"last-7-days");
 assert.equal(result.period.ends_at,at);
 assert.equal(result.evidence[0],evidence);
 assert.equal(result.pricing_observations[0].observed_at,at);
 assert.equal(result.claims[0].baseline_value,null);
 assert.equal(captured.length,1);
});

test("Telegram Bot API admin reads state and refuses to replace another webhook without opt-in",async()=>{
 const calls=[];
 const admin=createTelegramBotApiAdmin({token,fetchImpl:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  if(url.endsWith("/getMe"))return response({ok:true,result:{id:123456,is_bot:true,username:"jason_bourne_bot"}});
  if(url.endsWith("/getWebhookInfo"))return response({ok:true,result:{url:"https://old.example.com/hook"}});
  return response({ok:true,result:true});
 }});
 assert.equal((await admin.getMe()).id,123456);
 await assert.rejects(()=>admin.setWebhook({url:"https://staging.example.com/hook",secretToken:"s".repeat(48)}),
  /TELEGRAM_WEBHOOK_ALREADY_CONFIGURED_ELSEWHERE/);
 assert.equal(calls.filter(c=>c.url.endsWith("/setWebhook")).length,0);
});

test("Telegram webhook configuration is an explicit write and never drops pending updates",async()=>{
 const calls=[];
 const admin=createTelegramBotApiAdmin({token,fetchImpl:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  if(url.endsWith("/getWebhookInfo"))return response({ok:true,result:{url:"https://staging.example.com/hook"}});
  return response({ok:true,result:true});
 }});
 const result=await admin.setWebhook({url:"https://staging.example.com/hook",secretToken:"s".repeat(48)});
 assert.equal(result.configured,true);
 const write=calls.find(c=>c.url.endsWith("/setWebhook"));
 assert.equal(write.body.drop_pending_updates,false);
 assert.deepEqual(write.body.allowed_updates,["channel_post","edited_channel_post"]);
});

test("in-memory rate limiter rejects over-limit peers and separates peers by salted hash",()=>{
 let current=1000;
 const allow=createInMemoryTelegramRateLimiter({salt:"s".repeat(48),limit:2,windowMs:1000,now:()=>current});
 assert.equal(allow({remoteAddress:"10.0.0.1",method:"POST"}),true);
 assert.equal(allow({remoteAddress:"10.0.0.1",method:"POST"}),true);
 assert.equal(allow({remoteAddress:"10.0.0.1",method:"POST"}),false);
 assert.equal(allow({remoteAddress:"10.0.0.2",method:"POST"}),true);
 current+=1001;
 assert.equal(allow({remoteAddress:"10.0.0.1",method:"POST"}),true);
});

test("PostgreSQL pool requires TLS verification and bounded connection/query timeouts",async()=>{
 let config;
 class FakePool{constructor(value){config=value;}}
 const pool=await createPostgresPoolFromConfig({
  databaseUrl:new URL("postgresql://user:pass@db.example.com:5432/kratt"),
  databaseCaCertPath:null,
 },{PoolClass:FakePool});
 assert.ok(pool instanceof FakePool);
 assert.equal(config.ssl.rejectUnauthorized,true);
 assert.equal(config.ssl.minVersion,"TLSv1.2");
 assert.equal(config.connectionTimeoutMillis,8000);
 assert.equal(config.max,10);
});
