import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createTelegramCompetitiveWebhookHandler } from "../src/telegram-competitive-webhook-handler.mjs";

function request(body,{method="POST",contentType="application/json",secret="test-secret",contentLength}={}){
 const r=Readable.from([Buffer.from(body)]);
 r.method=method;r.headers={"content-type":contentType,"x-telegram-bot-api-secret-token":secret};
 if(contentLength!==undefined)r.headers["content-length"]=String(contentLength);
 r.socket={remoteAddress:"127.0.0.1"};
 return r;
}
function response(){
 return {headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}};
}
test("webhook handler enforces method, JSON type and rate limiting",async()=>{
 let called=0;
 const handle=createTelegramCompetitiveWebhookHandler({ingestion:{ingest:async()=>{called++;return{status:"OK"};}},allowRequest:async()=>true});
 let res=response();await handle(request("{}",{method:"GET"}),res);assert.equal(res.statusCode,405);
 res=response();await handle(request("{}",{contentType:"text/plain"}),res);assert.equal(res.statusCode,415);
 const blocked=createTelegramCompetitiveWebhookHandler({ingestion:{ingest:async()=>{called++;}},allowRequest:async()=>false});
 res=response();await blocked(request("{}",{}),res);assert.equal(res.statusCode,429);assert.equal(called,0);
});
test("webhook rejects oversize declared and streamed bodies before processing",async()=>{
 let called=0;
 const handle=createTelegramCompetitiveWebhookHandler({ingestion:{ingest:async()=>{called++;return{status:"OK"};}},allowRequest:async()=>true,maxBodyBytes:1024});
 let res=response();await handle(request("{}",{contentLength:2048}),res);assert.equal(res.statusCode,200);
 const large=request("x".repeat(2048));
 large.headers={"content-type":"application/json","x-telegram-bot-api-secret-token":"test-secret"};
 res=response();await handle(large,res);assert.equal(res.statusCode,200);assert.equal(called,0);
});
test("webhook forwards only bounded JSON plus Telegram secret and maps status",async()=>{
 let received;
 const handle=createTelegramCompetitiveWebhookHandler({ingestion:{ingest:async args=>{received=args;return{status:"DUPLICATE",reason:"duplicate"};}},allowRequest:async context=>context.method==="POST"});
 const update={update_id:1,channel_post:{text:"hello"}};
 const res=response();await handle(request(JSON.stringify(update)),res);
 assert.equal(res.statusCode,200);
 assert.deepEqual(received,{update,receivedSecret:"test-secret"});
 assert.equal(res.headers["cache-control"],"no-store");
});

test("authenticated rejected or replay-blocked updates are acknowledged to prevent webhook retry loops",async()=>{
 const handle=createTelegramCompetitiveWebhookHandler({ingestion:{ingest:async()=>({status:"BLOCKED",reason:"replay mismatch"})},allowRequest:async()=>true});
 const res=response();await handle(request("{}",{}),res);
 assert.equal(res.statusCode,200);
});
