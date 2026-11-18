const SECRET=/^[A-Za-z0-9_-]{1,256}$/;
const BOT_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CHANNEL_ID= /^-?[0-9]{1,24}$/;
const ROUTE=/^\/[A-Za-z0-9/_-]{1,160}$/;

function parseBool(value,name){
 if(value===undefined||value==="false")return false;
 if(value==="true")return true;
 throw new TypeError(name+"_MUST_BE_TRUE_OR_FALSE");
}

/**
 * Read only the non-secret staging configuration. Secret values are kept
 * in the returned closure-facing object and are never included in health output.
 */
export function readCompetitiveStagingConfig(env={}){
 if(!env||typeof env!=="object"||Array.isArray(env))throw new TypeError("STAGING_ENV_INVALID");
 const enabled=parseBool(env.KRATT_COMPETITIVE_INGRESS_ENABLED,"KRATT_COMPETITIVE_INGRESS_ENABLED");
 const deploymentEnvironment=typeof env.KRATT_DEPLOYMENT_ENV==="string"?env.KRATT_DEPLOYMENT_ENV:"unset";
 const route=env.TELEGRAM_COMPETITIVE_WEBHOOK_PATH??"/webhooks/telegram/competitive";
 if(typeof route!=="string"||!ROUTE.test(route)||route.includes("//")||route.endsWith("/"))
  throw new TypeError("TELEGRAM_COMPETITIVE_WEBHOOK_PATH_INVALID");
 if(!enabled)return Object.freeze({
  enabled:false,environment:deploymentEnvironment,route,maxBodyBytes:64*1024,maxTextBytes:16_384,
  channelIds:Object.freeze([]),botId:null,webhookSecret:null
 });
 if(deploymentEnvironment!=="staging")throw new Error("COMPETITIVE_INGRESS_STAGING_ONLY");
 const webhookSecret=env.TELEGRAM_WEBHOOK_SECRET;
 const botId=env.TELEGRAM_BOT_ID;
 if(typeof webhookSecret!=="string"||!SECRET.test(webhookSecret))throw new TypeError("TELEGRAM_WEBHOOK_SECRET_INVALID");
 if(typeof botId!=="string"||!BOT_ID.test(botId))throw new TypeError("TELEGRAM_BOT_ID_INVALID");
 const rawChannels=env.TELEGRAM_COMPETITIVE_CHANNEL_IDS;
 if(typeof rawChannels!=="string"||rawChannels.length<1||rawChannels.length>4096)
  throw new TypeError("TELEGRAM_CHANNEL_ALLOWLIST_REQUIRED");
 const channelIds=rawChannels.split(",").map(value=>value.trim());
 if(channelIds.length<1||channelIds.length>128||channelIds.some(value=>!CHANNEL_ID.test(value))||
  new Set(channelIds).size!==channelIds.length)throw new TypeError("TELEGRAM_CHANNEL_ALLOWLIST_INVALID");
 const maxBodyBytes=env.TELEGRAM_COMPETITIVE_MAX_BODY_BYTES===undefined?64*1024:Number(env.TELEGRAM_COMPETITIVE_MAX_BODY_BYTES);
 const maxTextBytes=env.TELEGRAM_COMPETITIVE_MAX_TEXT_BYTES===undefined?16_384:Number(env.TELEGRAM_COMPETITIVE_MAX_TEXT_BYTES);
 const rateLimitSalt=env.TELEGRAM_INGRESS_RATE_LIMIT_SALT;
 const rateLimit=env.TELEGRAM_INGRESS_RATE_LIMIT===undefined?30:Number(env.TELEGRAM_INGRESS_RATE_LIMIT);
 const rateWindowMs=env.TELEGRAM_INGRESS_RATE_WINDOW_MS===undefined?60_000:Number(env.TELEGRAM_INGRESS_RATE_WINDOW_MS);
 if(typeof rateLimitSalt!=="string"||rateLimitSalt.length<16||rateLimitSalt.length>256||
  !Number.isInteger(rateLimit)||rateLimit<1||rateLimit>10_000||
  !Number.isInteger(rateWindowMs)||rateWindowMs<1000||rateWindowMs>24*60*60_000||
  !Number.isInteger(maxBodyBytes)||maxBodyBytes<1024||maxBodyBytes>1024*1024||
  !Number.isInteger(maxTextBytes)||maxTextBytes<256||maxTextBytes>128*1024)
  throw new TypeError("TELEGRAM_COMPETITIVE_SIZE_LIMIT_INVALID");
 return Object.freeze({enabled:true,environment:deploymentEnvironment,route,maxBodyBytes,maxTextBytes,
  channelIds:Object.freeze(channelIds),botId,webhookSecret,rateLimitSalt,rateLimit,rateWindowMs});
}
