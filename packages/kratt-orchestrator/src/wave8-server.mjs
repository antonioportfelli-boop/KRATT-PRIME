import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadWave8Config, createTelegramBotApiAdmin, createInMemoryTelegramRateLimiter,
 createPostgresPoolFromConfig, createWave8Engines } from "./wave8-live-connectors.mjs";
import { createPostgresCompetitiveIntelStore } from "../../kratt-core/src/postgres-competitive-snapshot-store.mjs";
import { createTelegramCompetitiveIngestion } from "../../kratt-core/src/telegram-competitive-ingestion.mjs";
import { createTelegramCompetitiveWebhookHandler } from "./telegram-competitive-webhook-handler.mjs";

function json(response,status,body){
 response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
  "x-content-type-options":"nosniff","referrer-policy":"no-referrer"});
 response.end(JSON.stringify(body));
}
function log(event,fields={}){
 process.stdout.write(JSON.stringify({time:new Date().toISOString(),level:"info",event,...fields})+"\n");
}
async function assertSchema(pool){
 const result=await pool.query(
  "SELECT to_regclass('public.kratt_telegram_competitive_inbox') AS inbox,"+
  "to_regclass('public.kratt_competitor_snapshots') AS snapshots,"+
  "to_regclass('public.kratt_competitor_snapshot_events') AS events,"+
  "to_regclass('public.kratt_competitor_snapshot_head') AS head");
 const row=result.rows?.[0]??{};
 const missing=["inbox","snapshots","events","head"].filter(key=>!row[key]);
 if(missing.length)throw new Error("WAVE8_DATABASE_SCHEMA_MISSING:"+missing.join(","));
}

export async function createWave8StagingServer({env=process.env,PoolClass,fetchImpl=globalThis.fetch}={}){
 const config=loadWave8Config(env);
 const pool=await createPostgresPoolFromConfig(config,{PoolClass});
 let closed=false;
 try{
  await pool.query("SELECT 1 AS connected");
  await assertSchema(pool);
  const store=createPostgresCompetitiveIntelStore(pool);
  const engines=await createWave8Engines({config,fetchImpl});
  const ingestion=createTelegramCompetitiveIngestion({
   webhookSecret:config.telegramWebhookSecret,botId:config.telegramBotId,
   allowedChannelIds:config.telegramAllowedChannelIds,parseSignal:engines.parseSignal,
   engine:engines.competitiveEngine,store,
  });
  const rateLimiter=createInMemoryTelegramRateLimiter({
   salt:config.telegramRateLimitSalt,limit:30,windowMs:60_000,
  });
  const telegram=createTelegramBotApiAdmin({token:config.telegramBotToken,fetchImpl});
  const bot=await telegram.getMe();
  if(String(bot.id)!==config.telegramBotId)throw new Error("TELEGRAM_BOT_ID_MISMATCH");
  let webhookInfo=await telegram.getWebhookInfo();
  let dbReady=true,telegramReady=true;
  const handler=createTelegramCompetitiveWebhookHandler({ingestion,allowRequest:rateLimiter,maxBodyBytes:64*1024});
  const server=createServer(async(request,response)=>{
   const url=new URL(request.url??"/","http://localhost");
   if(request.method==="GET"&&url.pathname==="/health/live")
    return json(response,200,{status:"LIVE",service:"kratt-prime-wave8"});
   if(request.method==="GET"&&url.pathname==="/health/ready"){
    let chain={ok:false,reason:"NOT_CHECKED"};
    try{await pool.query("SELECT 1");chain=await store.verifySnapshotChain();dbReady=chain.ok!==false;}
    catch{dbReady=false;}
    try{webhookInfo=await telegram.getWebhookInfo();telegramReady=true;}
    catch{telegramReady=false;}
    const webhookReady=webhookInfo.url===config.webhookPublicUrl;
    const ready=dbReady&&telegramReady;
    return json(response,ready?200:503,{status:ready?"READY":"NOT_READY",
     checks:{postgres:dbReady,telegramApi:telegramReady,webhookConfigured:webhookReady,snapshotChain:chain.ok===true},
     webhook:{configuredUrl:config.webhookPublicUrl,activeUrl:webhookInfo.url||null},
     details:chain.ok===true?undefined:chain.reason??"CHECK_FAILED"});
   }
   if(request.method==="POST"&&url.pathname===config.webhookPath)
    return handler(request,response);
   return json(response,404,{status:"NOT_FOUND"});
  });
  server.headersTimeout=10_000;
  server.requestTimeout=90_000;
  server.keepAliveTimeout=5_000;
  server.maxHeadersCount=32;
  const listen=()=>new Promise((resolve,reject)=>{
   server.once("error",reject);
   server.listen(config.port,config.host,()=>{server.off("error",reject);resolve();});
  });
  await listen();
  log("wave8.server_started",{host:config.host,port:config.port,webhookPath:config.webhookPath,botId:config.telegramBotId});
  const close=async()=>{
   if(closed)return;closed=true;
   await new Promise(resolve=>server.close(()=>resolve()));
   await pool.end();
   log("wave8.server_stopped");
  };
  return Object.freeze({server,pool,store,telegram,config,close});
 }catch(error){
  try{await pool.end();}catch{}
  throw error;
 }
}

async function main(){
 let runtime;
 try{
  runtime=await createWave8StagingServer();
  const shutdown=async(signal)=>{
   log("wave8.shutdown_requested",{signal});
   try{await runtime.close();process.exitCode=0;}
   catch{process.exitCode=1;}
  };
  process.once("SIGINT",()=>void shutdown("SIGINT"));
  process.once("SIGTERM",()=>void shutdown("SIGTERM"));
 }catch(error){
  const code=String(error?.message??"WAVE8_START_FAILED").split(":")[0];
  process.stderr.write(JSON.stringify({time:new Date().toISOString(),level:"error",event:"wave8.start_failed",code})+"\n");
  process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
