import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createPostgresTelegramIngressRateLimiter } from "../src/postgres-telegram-ingress-rate-limiter.mjs";

function fakePool(){
 const buckets=new Map(),calls=[];
 return {buckets,calls,async query(sql,params=[]){
  const q=sql.toLowerCase();
  calls.push({sql,params});
  if(q.startsWith("insert into kratt_telegram_ingress_rate_limits")){
   const [hash,now,windowMs]=params;
   const prior=buckets.get(hash);
   let next;
   if(!prior||now>=prior.windowStart+windowMs||now<prior.windowStart)next={windowStart:now,count:1};
   else next={windowStart:prior.windowStart,count:prior.count+1};
   buckets.set(hash,next);return{rowCount:1,rows:[{request_count:next.count}]};
  }
  if(q.startsWith("delete from kratt_telegram_ingress_rate_limits")){
   for(const [key,value] of buckets)if(value.windowStart<params[0])buckets.delete(key);
   return{rowCount:0,rows:[]};
  }
  throw new Error("UNEXPECTED_QUERY");
 }};
}

test("shared PostgreSQL limiter enforces a per-peer fixed window and resets on expiry",async()=>{
 const pool=fakePool();let now=100_000;
 const allow=createPostgresTelegramIngressRateLimiter(pool,{salt:"0123456789abcdef-rate-salt",limit:2,windowMs:10_000,
  clock:()=>now,cleanupEvery:100});
 assert.equal(await allow({remoteAddress:"203.0.113.10",method:"POST"}),true);
 assert.equal(await allow({remoteAddress:"203.0.113.10",method:"POST"}),true);
 assert.equal(await allow({remoteAddress:"203.0.113.10",method:"POST"}),false);
 assert.equal(await allow({remoteAddress:"203.0.113.11",method:"POST"}),true);
 now+=10_000;
 assert.equal(await allow({remoteAddress:"203.0.113.10",method:"POST"}),true);
 assert.equal(pool.buckets.size,2);
 const expected=createHmac("sha256","0123456789abcdef-rate-salt").update("203.0.113.10","utf8").digest("hex");
 assert.equal(pool.buckets.has(expected),true);
 assert.equal([...pool.buckets.keys()].some(key=>key.includes("203.0.113.10")),false);
 assert.equal(JSON.stringify(pool.calls).includes("203.0.113.10"),false);
});

test("rate limiter fails closed on invalid peers, methods and database errors",async()=>{
 const pool=fakePool();
 const allow=createPostgresTelegramIngressRateLimiter(pool,{salt:"0123456789abcdef-rate-salt"});
 assert.equal(await allow({remoteAddress:null,method:"POST"}),false);
 assert.equal(await allow({remoteAddress:"127.0.0.1",method:"GET"}),false);
 const broken=createPostgresTelegramIngressRateLimiter({query:async()=>{throw new Error("db down");}},
  {salt:"0123456789abcdef-rate-salt"});
 assert.equal(await broken({remoteAddress:"127.0.0.1",method:"POST"}),false);
});

test("rate limiter constructor rejects weak salts and unsafe limits",()=>{
 assert.throws(()=>createPostgresTelegramIngressRateLimiter(fakePool(),{salt:"short"}),/SALT_REQUIRED/);
 assert.throws(()=>createPostgresTelegramIngressRateLimiter(fakePool(),{salt:"0123456789abcdef",limit:0}),/CONFIG_INVALID/);
});
