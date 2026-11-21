import test from "node:test";
import assert from "node:assert/strict";
import { createObservedTelegramIngestion } from "../src/observed-telegram-ingestion.mjs";

test("Telegram ingestion is durably observed without persisting raw update or webhook secret",async()=>{
 const events=[];
 const ingestion={ingest:async()=>({status:"OK",reason:"COMMITTED"})};
 const adapter=createObservedTelegramIngestion({
  ingestion,store:{append:async event=>{events.push(event);return{ok:true};}},
  environment:"test",runtimeVersion:"node22.0.0",idFactory:()=>"delivery-1",
 });
 const secret="do-not-persist-this-secret";
 const update={update_id:42,message:{text:"private message must not be stored"}};
 const result=await adapter.ingest({update,receivedSecret:secret});
 assert.deepEqual(result,{status:"OK",reason:"COMMITTED"});
 assert.deepEqual(events.map(event=>event.status),["queued","running","succeeded"]);
 const serialized=JSON.stringify(events);
 assert.doesNotMatch(serialized,/do-not-persist-this-secret|private message must not be stored/);
 assert.equal(events[0].operation_id,"telegram-delivery-delivery-1");
 assert.equal(events[0].correlation_id,"telegram-update-42");
 assert.equal(events[0].input_ref,"telegram-update:42");
 assert.equal(events[2].output_ref,"telegram-result:OK");
});
test("Telegram operation is blocked before ingestion when the observability queue cannot be stored",async()=>{
 let executed=false;
 const adapter=createObservedTelegramIngestion({
  ingestion:{ingest:async()=>{executed=true;return{status:"OK"};}},
  store:{append:async()=>({ok:false})},environment:"test",idFactory:()=>"delivery-2",
 });
 const result=await adapter.ingest({update:{update_id:43},receivedSecret:"secret"});
 assert.deepEqual(result,{status:"ERROR",reason:"OBSERVABILITY_EXECUTION_BLOCKED"});
 assert.equal(executed,false);
});
test("each Telegram delivery attempt gets a distinct operation while retaining update correlation",async()=>{
 const events=[];let n=0;
 const adapter=createObservedTelegramIngestion({
  ingestion:{ingest:async()=>({status:"DUPLICATE"})},
  store:{append:async event=>{events.push(event);return{ok:true};}},
  environment:"test",idFactory:()=> "delivery-"+(++n),
 });
 await adapter.ingest({update:{update_id:99},receivedSecret:"x"});
 await adapter.ingest({update:{update_id:99},receivedSecret:"x"});
 assert.equal(new Set(events.filter(e=>e.status==="queued").map(e=>e.operation_id)).size,2);
 assert.equal(new Set(events.filter(e=>e.status==="queued").map(e=>e.correlation_id)).size,1);
});
