import { loadWave8Config, createTelegramBotApiAdmin, createPostgresPoolFromConfig } from "../packages/kratt-orchestrator/src/wave8-live-connectors.mjs";
import { createPostgresCompetitiveIntelStore } from "../packages/kratt-core/src/postgres-competitive-snapshot-store.mjs";

let pool;
try{
 const config=loadWave8Config();
 pool=await createPostgresPoolFromConfig(config);
 const db=await pool.query("SELECT current_database() AS database, current_user AS role, now() AS server_time");
 const schema=await pool.query(
  "SELECT to_regclass('public.kratt_telegram_competitive_inbox') AS inbox,"+
  "to_regclass('public.kratt_competitor_snapshots') AS snapshots,"+
  "to_regclass('public.kratt_competitor_snapshot_events') AS events,"+
  "to_regclass('public.kratt_competitor_snapshot_head') AS head,"
  +"to_regclass('public.kratt_telegram_ingress_rate_limits') AS rate_limits");
 const missing=["inbox","snapshots","events","head","rate_limits"].filter(k=>!schema.rows?.[0]?.[k]);
 const store=createPostgresCompetitiveIntelStore(pool);
 const chain=await store.verifySnapshotChain();
 const bot=await createTelegramBotApiAdmin({token:config.telegramBotToken}).getMe();
 const webhook=await createTelegramBotApiAdmin({token:config.telegramBotToken}).getWebhookInfo();
 const botMatches=String(bot.id)===config.telegramBotId;
 const webhookMatches=webhook.url===config.webhookPublicUrl;
 const result={
  postgres:{connected:true,database:db.rows[0].database,role:db.rows[0].role,schemaMissing:missing},
  snapshotChain:chain,
  telegram:{connected:true,botId:String(bot.id),username:bot.username??null,configuredBotIdMatches:botMatches,
   webhookUrl:webhook.url||null,webhookMatches},
 };
 process.stdout.write(JSON.stringify(result,null,2)+"\n");
 if(missing.length||!chain.ok||!botMatches||!webhookMatches)process.exitCode=2;
}catch(error){
 const reason=String(error?.message??"WAVE8_PREFLIGHT_FAILED").split(":")[0];
 process.stderr.write(JSON.stringify({status:"FAILED",reason})+"\n");
 process.exitCode=1;
}finally{if(pool)try{await pool.end();}catch{}}
