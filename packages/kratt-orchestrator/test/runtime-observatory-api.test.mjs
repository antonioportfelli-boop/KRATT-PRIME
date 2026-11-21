import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeObservatoryApi } from "../src/runtime-observatory-api.mjs";

function fakeStore(){
 return{
  async listOperations(options){return[{operation_id:"operation-01",status:"running",...options}];},
  async getOperation(id){return id==="operation-01"?{operation_id:id,status:"succeeded"}:null;},
  async listEvents(id){return[{sequence:1,event_id:"event-1",operation_id:id,event:{status:"queued"},previous_hash:"internal-prev",hash:"internal-hash"}];},
  async summarizeModules(){return[{module_id:"kratt-core",total:1}];},
  async verifyChain(){return{ok:true,count:2,operations:1,head_hash:"secret-hash"};},
 };
}
test("observatory API denies reads without a successful server-side authorization result",async()=>{
 const api=createRuntimeObservatoryApi({store:fakeStore(),authorizeRead:async()=>false});
 const result=await api.handle({path:"/observatory/operations",principal:null});
 assert.equal(result.statusCode,403);
 assert.equal(result.body.reason,"OBSERVATORY_READ_NOT_AUTHORIZED");
});
test("observatory API returns operation timeline only after scope authorization",async()=>{
 const calls=[];
 const api=createRuntimeObservatoryApi({store:fakeStore(),authorizeRead:async input=>{
  calls.push(input);return input.resource==="operations"&&input.action==="read";
 }});
 const result=await api.handle({path:"/observatory/operations/operation-01/events",principal:{id:"operator-1"}});
 assert.equal(result.statusCode,200);
 assert.equal(result.body.data[0].event.status,"queued");
 assert.equal(Object.hasOwn(result.body.data[0],"hash"),false);
 assert.equal(Object.hasOwn(result.body.data[0],"previous_hash"),false);
 assert.equal(calls[0].operation_id,"operation-01");
});
test("observatory API supports module summaries and integrity without returning the internal hash",async()=>{
 const api=createRuntimeObservatoryApi({store:fakeStore(),authorizeRead:async()=>({ok:true})});
 const modules=await api.handle({path:"/observatory/modules"});
 const integrity=await api.handle({path:"/observatory/integrity"});
 assert.equal(modules.body.data[0].module_id,"kratt-core");
 assert.equal(integrity.body.data.ok,true);
 assert.equal(Object.hasOwn(integrity.body.data,"head_hash"),false);
});
test("observatory API rejects writes and unknown resources",async()=>{
 const api=createRuntimeObservatoryApi({store:fakeStore(),authorizeRead:async()=>true});
 assert.equal((await api.handle({method:"POST",path:"/observatory/operations"})).statusCode,405);
 assert.equal((await api.handle({path:"/observatory/secrets"})).statusCode,404);
});

test("observatory API rejects malformed, excessive and unknown list query parameters with 400",async()=>{
 const api=createRuntimeObservatoryApi({store:fakeStore(),authorizeRead:async()=>true});
 for(const query of [{limit:"1e3"},{limit:201},{limit:0},{module_id:"../secret"},{status:"UNKNOWN"},{unexpected:"value"}]){
  const result=await api.handle({path:"/observatory/operations",query});
  assert.equal(result.statusCode,400);
  assert.equal(result.body.reason,"QUERY_INVALID");
 }
});
test("observatory API does not invoke storage when list filters are invalid",async()=>{
 let calls=0;
 const store=fakeStore();
 store.listOperations=async()=>{calls++;return[];};
 const api=createRuntimeObservatoryApi({store,authorizeRead:async()=>true});
 const result=await api.handle({path:"/observatory/operations",query:{limit:"NaN"}});
 assert.equal(result.statusCode,400);
 assert.equal(calls,0);
});
test("operation event API passes a bounded sequence cursor",async()=>{const store=fakeStore();let captured;store.listEvents=async(_id,options)=>{captured=options;return[{sequence:8,status:"queued"}];};const api=createRuntimeObservatoryApi({store,authorizeRead:async()=>true});const result=await api.handle({path:"/observatory/operations/operation-01/events",query:{limit:"5",before_sequence:"12"}});assert.equal(captured.beforeSequence,12);assert.equal(captured.limit,5);assert.equal(result.body.next_before_sequence,8);});
