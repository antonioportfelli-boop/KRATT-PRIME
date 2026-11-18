import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresOutboxStore } from "../src/postgres-outbox-store.mjs";
import { canonicalTaskDigest } from "../src/policy.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";
const at="2026-11-18T16:00:00.000Z",zero="0".repeat(64);
const task={schema_version:KRATT_SCHEMA_VERSION,task_id:"pg-task-01",actor:"operator-01",action:"repo.read",
 target:{resource_type:"repository",resource_id:"KRATT-PRIME"},constraints:{provider:"github"},
 required_evidence:[],created_at:at,requested_authority:[],status:"PENDING"};
function pool({nonce=1,cancelled=0,intent=1,failOutbox=false}={}){
 const calls=[];let auditSeq=0;
 return{calls,async connect(){return{async query(sql,values=[]){
  const s=sql.replace(/\s+/g," ").trim();calls.push({sql:s,values});
  if(s==="BEGIN"||s==="COMMIT"||s==="ROLLBACK")return{rowCount:0,rows:[]};
  if(s.includes("pg_advisory_xact_lock"))return{rowCount:1,rows:[]};
  if(s.includes("INSERT INTO kratt_approval_nonces"))return{rowCount:nonce,rows:nonce?[{key_id:"pg-key"}]:[]};
  if(s.includes("SELECT task_id FROM kratt_cancelled_tasks"))return{rowCount:cancelled,rows:cancelled?[{task_id:task.task_id}]:[]};
  if(s.includes("INSERT INTO kratt_dispatch_intents"))return{rowCount:intent,rows:intent?[{idempotency_key:values[0]}]:[]};
  if(s.includes("INSERT INTO kratt_dispatch_outbox")){if(failOutbox)throw new Error("outbox down");return{rowCount:1,rows:[]};}
  if(s.includes("SELECT sequence,hash FROM kratt_audit_head"))return{rowCount:1,rows:[{sequence:auditSeq,hash:zero}]};
  if(s.includes("INSERT INTO kratt_audit_events")){auditSeq++;return{rowCount:1,rows:[]};}
  if(s.includes("UPDATE kratt_audit_head"))return{rowCount:1,rows:[]};
  throw new Error("Unexpected SQL: "+s);
 },release(){calls.push({sql:"RELEASE"});}};},async query(){throw new Error("pool.query not expected");}};
}
function approval(){return{key_id:"pg-key",nonce:"pg-nonce-01",approval_id:"pg-approval-01",expires_at:"2026-11-18T16:04:00.000Z",
 request_digest:canonicalTaskDigest(task),signature_digest:"a".repeat(64)};}
function reserve(store,approvalValue=approval()){
 const taskDigest=canonicalTaskDigest(task);
 return store.reserveAuthorizedIntent({task,principal:{id:task.actor},approval:approvalValue,
  idempotencyKey:"kratt:"+task.task_id+":"+taskDigest.slice(7),providerPayload:{task}});
}
test("reserve consumes verified nonce, intent, outbox and audit in one transaction",async()=>{
 const p=pool(),store=createPostgresOutboxStore(p,{clock:()=>new Date(at)});
 const r=await reserve(store);assert.equal(r.ok,true);
 const sql=p.calls.map(x=>x.sql);
 assert.equal(sql[0],"BEGIN");assert.ok(sql.some(s=>s.includes("INSERT INTO kratt_approval_nonces")));
 assert.ok(sql.some(s=>s.includes("INSERT INTO kratt_dispatch_intents")));
 assert.ok(sql.some(s=>s.includes("INSERT INTO kratt_dispatch_outbox")));
 assert.ok(sql.some(s=>s.includes("INSERT INTO kratt_audit_events")));
 assert.ok(sql.includes("COMMIT"));assert.equal(sql.includes("ROLLBACK"),false);
});
test("replayed approval nonce rolls the entire transaction back before intent",async()=>{
 const p=pool({nonce:0}),store=createPostgresOutboxStore(p,{clock:()=>new Date(at)});
 const r=await reserve(store);assert.equal(r.reason,"APPROVAL_REPLAYED");
 const sql=p.calls.map(x=>x.sql);assert.ok(sql.includes("ROLLBACK"));assert.equal(sql.includes("COMMIT"),false);
 assert.equal(sql.some(s=>s.includes("INSERT INTO kratt_dispatch_intents")),false);
});
test("task cancellation rolls back nonce consumption and prevents outbox",async()=>{
 const p=pool({cancelled:1}),store=createPostgresOutboxStore(p,{clock:()=>new Date(at)});
 const r=await reserve(store);assert.equal(r.reason,"TASK_CANCELLED");
 const sql=p.calls.map(x=>x.sql);assert.ok(sql.includes("ROLLBACK"));assert.equal(sql.includes("COMMIT"),false);
 assert.equal(sql.some(s=>s.includes("INSERT INTO kratt_dispatch_outbox")),false);
});
test("outbox persistence failure rolls back both nonce and intent",async()=>{
 const p=pool({failOutbox:true}),store=createPostgresOutboxStore(p,{clock:()=>new Date(at)});
 await assert.rejects(()=>reserve(store),/outbox down/);
 const sql=p.calls.map(x=>x.sql);assert.ok(sql.includes("ROLLBACK"));assert.equal(sql.includes("COMMIT"),false);
});
test("non-approval read task reserves intent without consuming approval nonce",async()=>{
 const p=pool(),store=createPostgresOutboxStore(p,{clock:()=>new Date(at)});
 const r=await reserve(store,null);assert.equal(r.ok,true);
 assert.equal(p.calls.some(x=>x.sql.includes("INSERT INTO kratt_approval_nonces")),false);
 assert.ok(p.calls.some(x=>x.sql.includes("INSERT INTO kratt_dispatch_outbox")));
});
test("caller cannot choose an idempotency key detached from the canonical task digest",async()=>{
 const p=pool(),store=createPostgresOutboxStore(p,{clock:()=>new Date(at)});
 const r=await store.reserveAuthorizedIntent({task,principal:{id:task.actor},approval:approval(),idempotencyKey:"kratt:attacker:"+"a".repeat(64)});
 assert.equal(r.reason,"RESERVATION_INPUT_INVALID");assert.equal(p.calls.length,0);
});


test("audit-chain verifier accepts an empty initialized PostgreSQL audit log",async()=>{
 const auditPool={async connect(){return{
  async query(sql){
   if(sql.startsWith("BEGIN")||sql==="COMMIT"||sql==="ROLLBACK")return{rowCount:0,rows:[]};
   if(sql.includes("FROM kratt_audit_events"))return{rowCount:0,rows:[]};
   if(sql.includes("FROM kratt_audit_head"))return{rowCount:1,rows:[{sequence:0,hash:zero}]};
   throw new Error("Unexpected verification SQL: "+sql);
  },release(){}
 };}};
 const store=createPostgresOutboxStore(auditPool,{clock:()=>new Date(at)});
 assert.deepEqual(await store.verifyAuditChain(),{ok:true,count:0,head_hash:zero});
});
