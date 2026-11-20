import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { createWave8StagingServer } from "../../kratt-orchestrator/src/wave8-server.mjs";

const token="123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function env(port){
 return {
  APP_ENV:"staging",HOST:"127.0.0.1",PORT:String(port),
  TELEGRAM_BOT_TOKEN:token,TELEGRAM_WEBHOOK_SECRET:"a".repeat(48),TELEGRAM_BOT_ID:"123456",
  TELEGRAM_ALLOWED_CHANNEL_IDS:"-1001234567890",TELEGRAM_RATE_LIMIT_SALT:"s".repeat(48),
  TELEGRAM_INGRESS_RATE_LIMIT:"30",TELEGRAM_INGRESS_RATE_WINDOW_MS:"60000",
  DATABASE_URL:"postgresql://kratt:secret@db.example.com:5432/kratt_staging",
  OPENAI_API_KEY:"sk-test-"+("k".repeat(32)),OPENAI_MODEL:"gpt-test-model",
  WEBHOOK_PUBLIC_URL:"https://staging.example.com/webhooks/telegram/competitive",
  COMPETITOR_SOURCE_ALLOWLIST:"salesforce.com,microsoft.com",MIN_INDEPENDENT_SOURCES:"2",
  WAVE8_ALLOW_TELEGRAM_TEXT_TO_OPENAI:"true",WAVE8_ENABLE_WEBHOOK_WRITES:"false",
 };
}
async function freePort(){
 const server=createTcpServer();
 await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
 const port=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 return port;
}
class FakePool{
 constructor(config){this.config=config;this.ended=false;this.rateLimitCalls=[];}
 async query(sql){
  if(sql.startsWith("SELECT to_regclass"))
   return{rows:[{inbox:"kratt_telegram_competitive_inbox",snapshots:"kratt_competitor_snapshots",
    events:"kratt_competitor_snapshot_events",head:"kratt_competitor_snapshot_head",
    rate_limits:"kratt_telegram_ingress_rate_limits"}],rowCount:1};
  if(sql.startsWith("INSERT INTO kratt_telegram_ingress_rate_limits")){
   this.rateLimitCalls.push(sql);
   return{rows:[{request_count:1}],rowCount:1};
  }
  if(sql.startsWith("DELETE FROM kratt_telegram_ingress_rate_limits"))return{rows:[],rowCount:0};
  if(sql.startsWith("SELECT 1"))return{rows:[{connected:1}],rowCount:1};
  throw new Error("FAKE_POOL_QUERY_UNSUPPORTED");
 }
 async connect(){
  return {query:async sql=>{
   if(sql.startsWith("BEGIN")||sql==="COMMIT"||sql==="ROLLBACK")return{rows:[],rowCount:0};
   if(sql.startsWith("SELECT sequence,event_id,snapshot_id,record_json"))return{rows:[],rowCount:0};
   if(sql.startsWith("SELECT sequence,hash FROM kratt_competitor_snapshot_head"))return{rows:[{sequence:0,hash:"0".repeat(64)}],rowCount:1};
   throw new Error("FAKE_POOL_CLIENT_QUERY_UNSUPPORTED");
  },release(){}};
 }
 async end(){this.ended=true;}
}

test("Wave 8 staging server starts only after live-adapter preflight and exposes readiness",async()=>{
 const port=await freePort();
 const urls=[];
 const fetchImpl=async(url,options)=>{
  urls.push(url);
  if(url.endsWith("/getMe"))return{ok:true,json:async()=>({ok:true,result:{id:123456,is_bot:true,username:"jason_bourne_bot"}})};
  if(url.endsWith("/getWebhookInfo"))return{ok:true,json:async()=>({ok:true,result:{url:"https://staging.example.com/webhooks/telegram/competitive",pending_update_count:0}})};
  throw new Error("UNEXPECTED_EXTERNAL_CALL");
 };
 const runtime=await createWave8StagingServer({env:env(port),PoolClass:FakePool,fetchImpl});
 try{
  const live=await fetch("http://127.0.0.1:"+port+"/health/live");
  const ready=await fetch("http://127.0.0.1:"+port+"/health/ready");
  assert.equal(live.status,200);
  assert.equal(ready.status,200);
  const body=await ready.json();
  assert.equal(body.status,"READY");
  assert.equal(body.checks.postgres,true);
  assert.equal(body.checks.telegramApi,true);
  assert.equal(body.checks.webhookConfigured,true);
  assert.equal(body.checks.snapshotChain,true);
  assert.equal(body.service,"kratt-prime-staging");
  assert.equal(Object.hasOwn(body,"webhook"),false);
  assert.equal(Object.hasOwn(body,"details"),false);
  assert.doesNotMatch(JSON.stringify(body),/staging\\.example\\.com|NOT_CHECKED|FAKE_POOL/);
  const webhook=await fetch("http://127.0.0.1:"+port+"/webhooks/telegram/competitive",{
   method:"POST",headers:{"content-type":"application/json","x-telegram-bot-api-secret-token":"a".repeat(48)},body:"{}",
  });
  assert.ok(webhook.status<500);
  assert.equal(runtime.pool.rateLimitCalls.length,1,"live webhook must use the shared PostgreSQL limiter");
  assert.equal(urls.length,3); // getMe at startup, then getWebhookInfo at startup and readiness.
  const missing=await fetch("http://127.0.0.1:"+port+"/not-found");
  assert.equal(missing.status,404);
 }finally{await runtime.close();}
});
