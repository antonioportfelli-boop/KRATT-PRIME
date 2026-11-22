import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAsyncTrustedAuthorizationRuntime } from "../src/async-trusted-runtime.mjs";
import { canonicalApprovalPayload, canonicalTaskDigest } from "../src/policy.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";

const at="2026-11-18T16:00:00.000Z";
function fixtures(){
 const task={schema_version:KRATT_SCHEMA_VERSION,task_id:"task-wave5-01",actor:"operator-01",action:"repo.write",
  target:{resource_type:"repository",resource_id:"KRATT-PRIME"},constraints:{provider:"github"},required_evidence:[
   {claim_type:"TESTS_PASSED",subject:"KRATT-PRIME",required:true,revision:null}],
  created_at:at,requested_authority:["repository.write"],status:"PENDING"};
 const context={schema_version:KRATT_SCHEMA_VERSION,authorities:["repository.write"],
  allowed_targets:[{resource_type:"repository",resource_id:"KRATT-PRIME"}],
  policies:[{action:"repo.write",required_authority:"repository.write",target_types:["repository"],
   side_effect_class:"EXTERNAL_WRITE",approval_required:true,approval_authority:"repository.approve",
   required_claims:["TESTS_PASSED"]}],evaluated_at:at};
 const evidence=[{schema_version:KRATT_SCHEMA_VERSION,evidence_id:"evidence-wave5-01",subject:"KRATT-PRIME",
  claim_type:"TESTS_PASSED",source:{source_type:"github",source_id:"run-wave5-01",revision:"0123456789012345678901234567890123456789"},
  observed_at:at,verification_method:"signed-attestation",result:"VERIFIED",artifact_digest:null,metadata:{}}];
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 const unsigned={schema_version:KRATT_SCHEMA_VERSION,approval_id:"approval-wave5-01",task_id:task.task_id,
  actor:task.actor,provider:"github",operation:task.action,target:task.target,request_digest:canonicalTaskDigest(task),
  key_id:"wave5-key",nonce:"wave5-nonce-01",issued_at:at,expires_at:"2026-11-18T16:04:00.000Z",
  decision:"APPROVE",approved_by:"security-owner",authority:"repository.approve",signature:"placeholder"};
 const approval={...unsigned,signature:sign(null,Buffer.from(canonicalApprovalPayload(unsigned),"utf8"),privateKey).toString("base64url")};
 const key={key_id:"wave5-key",approver_id:"security-owner",
  public_key_pem:publicKey.export({type:"spki",format:"pem"}),authorities:["repository.approve"]};
 return{task,context,evidence,approval,key};
}
function build({reserve,decisionContext,adapters={github:{dispatch:async()=>({status:"completed"})}}}={}){
 const f=fixtures(),calls=[];
 const store={
  async appendDecision(record){calls.push(["denial",record]);return true;},
  async reserveAuthorizedIntent(input){calls.push(["reserve",input]);return reserve?reserve(input):{
   ok:true,intent_id:"intent-01",outbox_id:"outbox-01",audit_sequence:1};},
 };
 const runtime=createAsyncTrustedAuthorizationRuntime({
  authenticatePrincipal:async()=>({id:"operator-01",active:true}),
  loadTrustedContext:async()=>decisionContext??f.context,
  loadEvidence:async()=>f.evidence,
  verifyEvidence:record=>record.source.source_type==="github"&&record.verification_method==="signed-attestation",
  trustedApprovalKeys:[f.key],commandStore:store,providerAdapters:adapters,now:()=>Date.parse(at),
 });
 return{runtime,calls,...f};
}
test("valid Ed25519 approval becomes one atomic nonce claim plus queued outbox intent",async()=>{
 const{runtime,calls,task,approval}=build();
 const result=await runtime.execute({principal:"trusted-session",task,approval});
 assert.equal(result.status,"QUEUED");
 assert.equal(calls.filter(c=>c[0]==="reserve").length,1);
 const reservation=calls.find(c=>c[0]==="reserve")[1];
 assert.equal(reservation.approval.nonce,"wave5-nonce-01");
 assert.equal(reservation.approval.request_digest,canonicalTaskDigest(task));
 assert.match(reservation.approval.signature_digest,/^[a-f0-9]{64}$/);
 assert.equal(reservation.idempotencyKey,result.idempotency_key);
 assert.equal(reservation.providerPayload.task.task_id,task.task_id);
});
test("signature tampering fails closed before nonce reservation",async()=>{
 const f=build();
 const last=f.approval.signature.at(-1);
 const bad={...f.approval,signature:f.approval.signature.slice(0,-1)+(last==="A"?"B":"A")};
 const result=await f.runtime.execute({principal:"trusted-session",task:f.task,approval:bad});
 assert.equal(result.status,"DENIED");
 assert.equal(result.reason,"APPROVAL_INVALID_OR_MISSING");
 assert.equal(f.calls.some(c=>c[0]==="reserve"),false);
});
test("missing trusted evidence blocks and creates no outbox reservation",async()=>{
 const f=build();
 const runtime=createAsyncTrustedAuthorizationRuntime({
  authenticatePrincipal:async()=>({id:"operator-01",active:true}),
  loadTrustedContext:async()=>f.context,loadEvidence:async()=>[],
  verifyEvidence:()=>true,trustedApprovalKeys:[f.key],
  commandStore:{appendDecision:async()=>true,reserveAuthorizedIntent:async()=>{throw new Error("must not reserve");}},
  providerAdapters:{github:{dispatch:async()=>({status:"completed"})}},now:()=>Date.parse(at),
 });
 const result=await runtime.execute({principal:"session",task:f.task,approval:f.approval});
 assert.equal(result.status,"DENIED");
 assert.equal(result.reason,"MISSING_TRUSTED_EVIDENCE");
});
test("task actor mismatch and missing provider adapter fail before database reservation",async()=>{
 const f=build();
 const wrong=await f.runtime.execute({principal:"session",task:{...f.task,actor:"attacker"},approval:f.approval});
 assert.equal(wrong.reason,"TASK_ACTOR_MISMATCH");
 const noAdapter=build({adapters:{}});
 const missing=await noAdapter.runtime.execute({principal:"session",task:noAdapter.task,approval:noAdapter.approval});
 assert.equal(missing.reason,"PROVIDER_ADAPTER_UNAVAILABLE");
 assert.equal(noAdapter.calls.some(c=>c[0]==="reserve"),false);
});
test("the runtime queues work and never executes a provider in the request path",async()=>{
 let providerCalls=0;
 const f=build({adapters:{github:{dispatch:async()=>{providerCalls++;return{status:"completed"};}}}});
 const result=await f.runtime.execute({principal:"session",task:f.task,approval:f.approval});
 assert.equal(result.status,"QUEUED");
 assert.equal(providerCalls,0);
});


test("failed atomic reservation is written as a separate denial audit event",async()=>{
 const f=build({reserve:async()=>({ok:false,reason:"TASK_CANCELLED"})});
 const result=await f.runtime.execute({principal:"session",task:f.task,approval:f.approval});
 assert.equal(result.status,"BLOCKED");
 assert.equal(result.reason,"TASK_CANCELLED");
 assert.equal(result.audit_recorded,true);
 const denial=f.calls.find(c=>c[0]==="denial");
 assert.equal(denial[1].reason,"TASK_CANCELLED");
});
