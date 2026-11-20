import { createPostgresCompetitiveIntelStore } from "./postgres-competitive-snapshot-store.mjs";
import { createTelegramCompetitiveIngestion } from "./telegram-competitive-ingestion.mjs";
import { createTelegramCompetitiveWebhookHandler } from "../../kratt-orchestrator/src/telegram-competitive-webhook-handler.mjs";
import { readCompetitiveStagingConfig } from "./competitive-staging-config.mjs";
import { createPostgresTelegramIngressRateLimiter } from "./postgres-telegram-ingress-rate-limiter.mjs";

/**
 * Assemble the staging-only Telegram -> parser -> MÕTLEMINE/CI engine -> PostgreSQL runtime.
 * It never starts a server, calls setWebhook, polls Telegram, or creates outbound Bot API calls.
 */
export function createCompetitiveStagingRuntime({
 env,postgresPool,parser,competitiveEngine,allowRequest,clock,makeSnapshotId,
}={}){
 const config=readCompetitiveStagingConfig(env);
 if(!config.enabled){
  return Object.freeze({
   enabled:false,
   route:config.route,
   handler:null,
   async readiness(){return Object.freeze({status:"DISABLED",reason:"COMPETITIVE_INGRESS_DISABLED",environment:config.environment});},
   mount(){return false;},
  });
 }
 if(!postgresPool||typeof postgresPool.connect!=="function")throw new TypeError("STAGING_POSTGRES_POOL_REQUIRED");
 if(!parser||typeof parser.parse!=="function")throw new TypeError("STAGING_COMPETITIVE_PARSER_REQUIRED");
 if(!competitiveEngine||typeof competitiveEngine.analyze!=="function")throw new TypeError("STAGING_COMPETITIVE_ENGINE_REQUIRED");
 const ingressRateLimiter=allowRequest??createPostgresTelegramIngressRateLimiter(postgresPool,{
  salt:config.rateLimitSalt,limit:config.rateLimit,windowMs:config.rateWindowMs,
  ...(clock?{clock:()=>{const value=clock();return value instanceof Date?value.getTime():Number(value);}}:{}),
 });
 if(typeof ingressRateLimiter!=="function")throw new TypeError("STAGING_INGRESS_RATE_LIMITER_REQUIRED");
 const store=createPostgresCompetitiveIntelStore(postgresPool,{...(clock?{clock}:{})});
 const ingestion=createTelegramCompetitiveIngestion({
  webhookSecret:config.webhookSecret,
  botId:config.botId,
  allowedChannelIds:config.channelIds,
  parseSignal:input=>parser.parse(input),
  engine:competitiveEngine,
  store,
  ...(clock?{clock}:{}),
  ...(makeSnapshotId?{makeSnapshotId}:{}),
  maxTextBytes:config.maxTextBytes,
 });
 const handler=createTelegramCompetitiveWebhookHandler({
  ingestion,allowRequest:ingressRateLimiter,maxBodyBytes:config.maxBodyBytes,
 });
 const runtime={
  enabled:true,
  route:config.route,
  handler,
  async readiness(){
   const database=await store.checkReady();
   const ready=database.ready===true;
   return Object.freeze({
    status:ready?"READY":"DEGRADED",
    environment:"staging",
    ingress_enabled:true,
    route:config.route,
    database:database.ready?"READY":"UNAVAILABLE",
    snapshot_chain:database.ready?"VALID":"NOT_VERIFIED",
    reason:database.reason,
   });
  },
  mount(router){
   if(!router||typeof router.post!=="function")throw new TypeError("STAGING_HTTP_ROUTER_REQUIRED");
   router.post(config.route,handler);
   let readinessMounted=false;
   if(typeof router.get==="function"){
    router.get("/health/competitive-intel/ready",async(_request,response)=>{
     const result=await runtime.readiness();
     response.statusCode=result.status==="READY"?200:503;
     response.setHeader("content-type","application/json; charset=utf-8");
     response.setHeader("cache-control","no-store");
     response.setHeader("x-content-type-options","nosniff");
     response.end(JSON.stringify(result));
    });
    readinessMounted=true;
   }
   return Object.freeze({ingressMounted:true,readinessMounted});
  },
 };
 return Object.freeze(runtime);
}
