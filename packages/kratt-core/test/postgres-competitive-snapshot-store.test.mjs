import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresCompetitiveIntelStore } from "../src/postgres-competitive-snapshot-store.mjs";

const at="2026-11-18T18:00:00.000Z";
const botId="jason-bourne";
const payloadDigest="sha256:"+"b".repeat(64);
const report={report_digest:"sha256:"+"a".repeat(64)};
function fixtureSnapshot(id="snapshot-0001",updateId=91){
 return {snapshot_id:id,competitor_id:"salesforce",captured_at:at,source_verified:true,
  source:{channel_id:"telegram-channel-n100",message_id:"telegram-message-901",source_id:"telegram-source-n100",
   update_id:updateId,permalink:"https://t.me/bourne_updates/901"},
  competitor_ids:["salesforce"],claim_values:[],pricing_observations:[],ranking_snapshot:null,
  report_status:"EVIDENCE_INCOMPLETE",weekly_change_status:"INCOMPLETE_BASELINE_OR_EVIDENCE",
  report_digest:report.report_digest,snapshot_version:"kratt-competitor-snapshot/v1"};
}
function fakePool(){
 const state={inbox:new Map(),snapshots:[],events:[],head:{sequence:0,hash:"0".repeat(64)}};
 async function query(sql,params=[]){
  const q=sql.toLowerCase().replace(/\s+/g," ").trim();
  if(q==="begin"||q.startsWith("begin isolation")||q==="commit"||q==="rollback")return{rowCount:0,rows:[]};
  if(q.startsWith("insert into kratt_telegram_competitive_inbox")){
   const key=params[0]+":"+params[1];
   if(state.inbox.has(key))return{rowCount:0,rows:[]};
   state.inbox.set(key,{bot_id:params[0],update_id:params[1],payload_digest:params[2],status:"PROCESSING",
    lease_token:params[3],lease_until:params[4],received_at:params[5]});
   return{rowCount:1,rows:[{update_id:params[1]}]};
  }
  if(q.startsWith("select payload_digest,status,lease_token,lease_until,snapshot_id,result_json from kratt_telegram_competitive_inbox")){
   const row=state.inbox.get(params[0]+":"+params[1]);return{rowCount:row?1:0,rows:row?[{...row}]:[]};
  }
  if(q.startsWith("update kratt_telegram_competitive_inbox set status='processing'")){
   const row=state.inbox.get(params[0]+":"+params[1]);
   if(row&&row.status==="PROCESSING"&&Date.parse(row.lease_until)<=Date.parse(params[6])){
    row.lease_token=params[3];row.lease_until=params[4];row.received_at=params[5];return{rowCount:1,rows:[{update_id:row.update_id}]};
   }
   return{rowCount:0,rows:[]};
  }
  if(q.startsWith("select payload_digest,status,lease_token from kratt_telegram_competitive_inbox")){
   const row=state.inbox.get(params[0]+":"+params[1]);return{rowCount:row?1:0,rows:row?[{...row}]:[]};
  }
  if(q.startsWith("select pg_advisory_xact_lock"))return{rowCount:1,rows:[{}]};
  if(q.startsWith("select snapshot_id from kratt_competitor_snapshots")){
   const rows=state.snapshots.filter(x=>x.competitor_id===params[0])
    .sort((a,b)=>Date.parse(b.captured_at)-Date.parse(a.captured_at)||b.snapshot_id.localeCompare(a.snapshot_id));
   return{rowCount:rows.length,rows:rows.length?[{snapshot_id:rows[0].snapshot_id}]:[]};
  }
  if(q.startsWith("insert into kratt_competitor_snapshots")){
   state.snapshots.push({snapshot_id:params[0],competitor_id:params[1],captured_at:params[2],
    bot_id:params[3],telegram_update_id:params[4],payload_digest:params[5],
    snapshot_json:JSON.parse(params[6]),snapshot_digest:params[7],previous_snapshot_id:params[8],created_at:params[9]});
   return{rowCount:1,rows:[]};
  }
  if(q.startsWith("select sequence,hash from kratt_competitor_snapshot_head")){
   return{rowCount:1,rows:[{...state.head}]};
  }
  if(q.startsWith("insert into kratt_competitor_snapshot_events")){
   state.events.push({sequence:params[0],event_id:params[1],snapshot_id:params[2],created_at:params[3],
    record_json:JSON.parse(params[4]),previous_hash:params[5],hash:params[6]});
   return{rowCount:1,rows:[]};
  }
  if(q.startsWith("update kratt_competitor_snapshot_head")){
   state.head={sequence:params[0],hash:params[1]};return{rowCount:1,rows:[]};
  }
  if(q.startsWith("update kratt_telegram_competitive_inbox set status='completed'")){
   const row=state.inbox.get(params[3]+":"+params[4]);
   if(!row||row.status!=="PROCESSING"||row.payload_digest!==params[5]||row.lease_token!==params[6])return{rowCount:0,rows:[]};
   Object.assign(row,{status:"COMPLETED",lease_token:null,lease_until:null,snapshot_id:params[0],
    result_json:JSON.parse(params[1]),completed_at:params[2]});
   return{rowCount:1,rows:[{update_id:row.update_id}]};
  }
  if(q.startsWith("delete from kratt_telegram_competitive_inbox")){
   const key=params[0]+":"+params[1],row=state.inbox.get(key);
   if(row&&row.payload_digest===params[2]&&row.status==="PROCESSING"&&row.lease_token===params[3]){
    state.inbox.delete(key);return{rowCount:1,rows:[]};
   }
   return{rowCount:0,rows:[]};
  }
  if(q.startsWith("select snapshot_id,competitor_id,snapshot_json,snapshot_digest from kratt_competitor_snapshots")){
   const rows=state.snapshots.filter(x=>x.competitor_id===params[0])
    .sort((a,b)=>Date.parse(b.captured_at)-Date.parse(a.captured_at)||b.snapshot_id.localeCompare(a.snapshot_id));
   const row=rows[0];
   return{rowCount:row?1:0,rows:row?[{snapshot_id:row.snapshot_id,competitor_id:row.competitor_id,
    snapshot_json:row.snapshot_json,snapshot_digest:row.snapshot_digest}]:[]};
  }
  if(q.startsWith("select sequence,event_id,snapshot_id,record_json,previous_hash,hash from kratt_competitor_snapshot_events")){
   return{rowCount:state.events.length,rows:state.events.slice().sort((a,b)=>a.sequence-b.sequence)};
  }
  throw new Error("FAKE_PG_UNSUPPORTED_QUERY:"+q);
 }
 const client={query,release(){}};
 return {state,query,async connect(){return client;}};
}
function storeFixture(){
 let current=Date.parse(at);
 const pool=fakePool();
 const store=createPostgresCompetitiveIntelStore(pool,{clock:()=>new Date(current),leaseMs:1000});
 return {pool,store,advance:ms=>{current+=ms;}};
}
async function claimed(store,updateId=91){
 return store.claimUpdate({botId,updateId,payloadDigest,receivedAt:at});
}

test("claims are idempotent and a lease can be reclaimed after expiry",async()=>{
 const {store,advance}=storeFixture();
 const first=await claimed(store);
 assert.equal(first.status,"CLAIMED");
 assert.equal((await claimed(store)).status,"PENDING");
 advance(1500);
 const reclaimed=await claimed(store);
 assert.equal(reclaimed.status,"CLAIMED");
 assert.notEqual(reclaimed.leaseToken,first.leaseToken);
 assert.equal((await store.claimUpdate({botId,updateId:91,payloadDigest:"sha256:"+"c".repeat(64),receivedAt:at})).status,"MISMATCH");
});

test("snapshot and inbox receipt commit atomically with immutable event digest",async()=>{
 const {store,pool}=storeFixture();
 const lease=await claimed(store);
 const snapshot=fixtureSnapshot();
 const saved=await store.commitSnapshot({botId,updateId:91,payloadDigest,leaseToken:lease.leaseToken,
  snapshot,report,expectedPreviousSnapshotId:null});
 assert.equal(saved.ok,true);
 assert.equal(pool.state.snapshots.length,1);
 assert.equal(pool.state.events.length,1);
 assert.equal(pool.state.inbox.get(botId+":91").status,"COMPLETED");
 const loaded=await store.getLatestSnapshot({competitorId:"salesforce"});
 assert.equal(loaded.verified,true);
 assert.equal(loaded.snapshot_id,"snapshot-0001");
 assert.equal((await store.verifySnapshotChain()).ok,true);
 const duplicate=await claimed(store);
 assert.equal(duplicate.status,"DUPLICATE");
 assert.equal(duplicate.snapshotId,"snapshot-0001");
});

test("stale expected baseline is rejected without writing snapshot or completing inbox",async()=>{
 const {store,pool}=storeFixture();
 const lease=await claimed(store,92);
 const result=await store.commitSnapshot({botId,updateId:92,payloadDigest,leaseToken:lease.leaseToken,
  snapshot:fixtureSnapshot("snapshot-stale",92),report,expectedPreviousSnapshotId:"snapshot-not-current"});
 assert.equal(result.reason,"BASELINE_CHANGED");
 assert.equal(pool.state.snapshots.length,0);
 assert.equal(pool.state.inbox.get(botId+":92").status,"PROCESSING");
});

test("snapshot hash and event chain detect persistent tampering",async()=>{
 const {store,pool}=storeFixture();
 const lease=await claimed(store);
 await store.commitSnapshot({botId,updateId:91,payloadDigest,leaseToken:lease.leaseToken,
  snapshot:fixtureSnapshot(),report,expectedPreviousSnapshotId:null});
 pool.state.snapshots[0].snapshot_json.report_status="FORGED";
 await assert.rejects(()=>store.getLatestSnapshot({competitorId:"salesforce"}),/COMPETITOR_SNAPSHOT_INTEGRITY_FAILED/);
 pool.state.events[0].record_json.event_type="FORGED";
 assert.equal((await store.verifySnapshotChain()).ok,false);
});

test("release removes only the matching active lease",async()=>{
 const {store,pool}=storeFixture();
 const lease=await claimed(store,93);
 assert.equal(await store.releaseUpdate({botId,updateId:93,payloadDigest,leaseToken:"competitive-lease:00000000-0000-4000-8000-000000000000"}),false);
 assert.equal(pool.state.inbox.size,1);
 assert.equal(await store.releaseUpdate({botId,updateId:93,payloadDigest,leaseToken:lease.leaseToken}),true);
 assert.equal(pool.state.inbox.size,0);
});
