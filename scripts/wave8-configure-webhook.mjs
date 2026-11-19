import { loadWave8Config, createTelegramBotApiAdmin } from "../packages/kratt-orchestrator/src/wave8-live-connectors.mjs";

async function main(){
 const config=loadWave8Config();
 if(process.env.APP_ENV!=="staging")throw new Error("WAVE8_WEBHOOK_STAGING_ONLY");
 if(!config.enableWebhookWrites)throw new Error("WAVE8_WEBHOOK_WRITE_OPT_IN_REQUIRED");
 const admin=createTelegramBotApiAdmin({token:config.telegramBotToken});
 const bot=await admin.getMe();
 if(String(bot.id)!==config.telegramBotId)throw new Error("TELEGRAM_BOT_ID_MISMATCH");
 const allowReplace=process.env.WAVE8_ALLOW_WEBHOOK_REPLACE==="true";
 const result=await admin.setWebhook({
  url:config.webhookPublicUrl,secretToken:config.telegramWebhookSecret,allowReplace,
 });
 process.stdout.write(JSON.stringify({status:"WEBHOOK_CONFIGURED",botId:String(bot.id),...result})+"\n");
}
main().catch(error=>{
 process.stderr.write(JSON.stringify({status:"FAILED",reason:String(error?.message??"WEBHOOK_CONFIG_FAILED").split(":")[0]})+"\n");
 process.exitCode=1;
});
