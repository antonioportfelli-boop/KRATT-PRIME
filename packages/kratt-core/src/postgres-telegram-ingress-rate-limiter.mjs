import { createHmac } from "node:crypto";

/**
 * Multi-instance fixed-window ingress limiter.
 * Only an HMAC of the trusted socket peer address is persisted; forwarded
 * headers are intentionally ignored. Requires migration 0002.
 */
export function createPostgresTelegramIngressRateLimiter(pool,{
 salt,limit=30,windowMs=60_000,clock=()=>Date.now(),cleanupEvery=1000,
}={}){
 if(!pool||typeof pool.query!=="function")throw new TypeError("TELEGRAM_RATE_LIMIT_POSTGRES_POOL_REQUIRED");
 if(typeof salt!=="string"||salt.length<16||salt.length>256)throw new TypeError("TELEGRAM_RATE_LIMIT_SALT_REQUIRED");
 if(!Number.isInteger(limit)||limit<1||limit>10_000||
  !Number.isInteger(windowMs)||windowMs<1000||windowMs>24*60*60_000||
  typeof clock!=="function"||!Number.isInteger(cleanupEvery)||cleanupEvery<1||cleanupEvery>100_000)
  throw new TypeError("TELEGRAM_RATE_LIMIT_CONFIG_INVALID");
 let calls=0;
 return async function allowTelegramCompetitiveIngress({remoteAddress,method}={}){
  if(method!=="POST"||typeof remoteAddress!=="string"||remoteAddress.length<1||remoteAddress.length>128)return false;
  let now;
  try{now=clock();}catch{return false;}
  if(!Number.isSafeInteger(now)||now<0)return false;
  const bucket=createHmac("sha256",salt).update(remoteAddress,"utf8").digest("hex");
  try{
   const result=await pool.query(
    "INSERT INTO kratt_telegram_ingress_rate_limits(bucket_hash,window_start_ms,request_count) VALUES($1,$2,1) "+
    "ON CONFLICT(bucket_hash) DO UPDATE SET "+
    "window_start_ms=CASE WHEN EXCLUDED.window_start_ms>=kratt_telegram_ingress_rate_limits.window_start_ms+$3 "+
    "OR EXCLUDED.window_start_ms<kratt_telegram_ingress_rate_limits.window_start_ms "+
    "THEN EXCLUDED.window_start_ms ELSE kratt_telegram_ingress_rate_limits.window_start_ms END, "+
    "request_count=CASE WHEN EXCLUDED.window_start_ms>=kratt_telegram_ingress_rate_limits.window_start_ms+$3 "+
    "OR EXCLUDED.window_start_ms<kratt_telegram_ingress_rate_limits.window_start_ms "+
    "THEN 1 ELSE kratt_telegram_ingress_rate_limits.request_count+1 END "+
    "RETURNING request_count",
    [bucket,now,windowMs]);
   const count=Number(result.rows?.[0]?.request_count);
   if(!Number.isSafeInteger(count)||count<1)return false;
   calls++;
   if(calls%cleanupEvery===0){
    try{await pool.query("DELETE FROM kratt_telegram_ingress_rate_limits WHERE window_start_ms<$1",[now-windowMs*2]);}
    catch{}
   }
   return count<=limit;
  }catch{return false;}
 };
}
