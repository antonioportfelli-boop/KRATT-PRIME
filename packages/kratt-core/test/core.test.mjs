import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* SQLite runtime unavailable on this Node build. */ }
import { createTrustedAuthorizationRuntime } from "../src/trusted-runtime.mjs";
import { createSqliteNonceStore } from "../src/sqlite-nonce-store.mjs";
import { KRATT_SCHEMA_VERSION, validateTaskEnvelope } from "../src/contracts.mjs";
import { evaluatePolicy, createRequestBoundApprovalVerifier, canonicalApprovalPayload, canonicalTaskDigest } from "../src/policy.mjs";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { createSaga, transitionSaga } from "../src/saga.mjs";
import { AgentRegistry } from "../src/agent-registry.mjs";

const at = "2026-11-04T07:00:00Z";
const now = Date.parse(at);
const task = (overrides={}) => ({schema_version:KRATT_SCHEMA_VERSION,task_id:"task-1",actor:"builder",action:"repo.read",target:{resource_type:"repository",resource_id:"KRATT-PRIME"},constraints:{branch:"integration"},required_evidence:[],created_at:at,requested_authority:["admin"],status:"PENDING",...overrides});
const context = (overrides={}) => ({schema_version:KRATT_SCHEMA_VERSION,authorities:["repository.read"],allowed_targets:[{resource_type:"repository",resource_id:"KRATT-PRIME"}],policies:[{action:"repo.read",required_authority:"repository.read",target_types:["repository"],side_effect_class:"READ_ONLY"}],evaluated_at:at,...overrides});
const evidence = () => ({schema_version:KRATT_SCHEMA_VERSION,evidence_id:"ev-1",subject:"KRATT-PRIME",claim_type:"TESTS_PASSED",source:{source_type:"github",source_id:"run-1",revision:"0123456789012345678901234567890123456789"},observed_at:at,verification_method:"signed-attestation",result:"VERIFIED",artifact_digest:null,metadata:{}});
const verifyEvidence = record => record.source.source_type === "github" && record.verification_method === "signed-attestation";

test("task contract rejects unrecognized privilege fields",()=>{assert.equal(validateTaskEnvelope(task()).ok,true);assert.equal(validateTaskEnvelope({...task(),admin:true}).ok,false);});
test("policy uses trusted context, never task requested authority",()=>{
 assert.equal(evaluatePolicy(task(),[],context(),{now}).decision,"ALLOW");
 assert.equal(evaluatePolicy(task(),[],context({authorities:[]}),{now}).decision,"DENY");
 assert.equal(evaluatePolicy(task({target:{resource_type:"repository",resource_id:"OTHER"}}),[],context(),{now}).decision,"DENY");
});
test("invalid trusted context blocks",()=>{assert.equal(evaluatePolicy(task(),[],null,{now}).decision,"BLOCKED");});
test("caller-provided VERIFIED flag is not trusted",()=>{
 const t=task({required_evidence:[{claim_type:"TESTS_PASSED",subject:"repo-1",required:true,revision:null}]});
 assert.equal(evaluatePolicy(t,[evidence()],context(),{now}).decision,"INSUFFICIENT_EVIDENCE");
 assert.equal(evaluatePolicy(t,[evidence()],context(),{now,verifyEvidence}).decision,"ALLOW");
});
test("external write with empty evidence is denied",()=>{
 const t=task({action:"repo.write"});
 const c=context({policies:[{action:"repo.write",required_authority:"repository.read",target_types:["repository"],side_effect_class:"EXTERNAL_WRITE",approval_required:true,approval_authority:"repository.approve"}]});
 assert.equal(evaluatePolicy(t,[],c,{now,approvalVerifier:()=>true}).decision,"DENY");
});
const writeTask = (overrides={}) => task({action:"repo.write",constraints:{provider:"github"},required_evidence:[{claim_type:"TESTS_PASSED",subject:"KRATT-PRIME",required:true,revision:null}],...overrides});
const writeContext = () => context({policies:[{action:"repo.write",required_authority:"repository.read",target_types:["repository"],side_effect_class:"EXTERNAL_WRITE",approval_required:true,approval_authority:"repository.approve",required_claims:["TESTS_PASSED"]}]});
const approvalArtifact = (overrides={}) => ({
 schema_version:KRATT_SCHEMA_VERSION,approval_id:"approval-1",task_id:"task-1",actor:"builder",
 provider:"github",operation:"repo.write",target:{resource_type:"repository",resource_id:"KRATT-PRIME"},
 request_digest:canonicalTaskDigest(writeTask()),key_id:"test-ed25519",nonce:"nonce-1",issued_at:at,expires_at:"2026-11-04T07:04:00Z",decision:"APPROVE",
 approved_by:"security-owner",authority:"repository.approve",signature:"test-signature",...overrides
});
function approvalVerifierFor(artifact, consumed=new Set()) {
 return createRequestBoundApprovalVerifier({
  now:()=>now,
  verifySignature:(payload,signature)=>signature==="test-signature" && payload===canonicalApprovalPayload(artifact),
  consumeNonce:(nonce)=>{if(consumed.has(nonce))return false;consumed.add(nonce);return true;}
 });
}
test("SQLite nonce store persists atomic one-time claims across connections",{skip:!DatabaseSync},()=>{
 const directory=mkdtempSync(join(tmpdir(),"kratt-nonce-"));
 const path=join(directory,"nonce.sqlite");
 try {
  const firstDb=new DatabaseSync(path);
  const first=createSqliteNonceStore(firstDb);
  assert.equal(first.consume("key-a","nonce-a","approval-a","2026-11-04T07:04:00Z",now),true);
  assert.equal(first.consume("key-a","nonce-a","approval-b","2026-11-04T07:04:00Z",now),false);
  assert.equal(first.consume("key-a","nonce-b","approval-a","2026-11-04T07:04:00Z",now),false);
  firstDb.close();
  const secondDb=new DatabaseSync(path);
  const second=createSqliteNonceStore(secondDb);
  assert.equal(second.consume("key-a","nonce-a","approval-a","2026-11-04T07:04:00Z",now),false);
  assert.equal(second.consume("key-b","nonce-a","approval-a","2026-11-04T07:04:00Z",now),true);
  secondDb.close();
 } finally {
  rmSync(directory,{recursive:true,force:true});
 }
});
test("trusted composition root verifies Ed25519 approval and enforces durable nonce adapter contract",()=>{
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 const unsigned=approvalArtifact({key_id:"prod-test-key",signature:"placeholder"});
 const payload=canonicalApprovalPayload(unsigned);
 const signed={...unsigned,signature:sign(null,Buffer.from(payload,"utf8"),privateKey).toString("base64url")};
 const used=new Set();
 const runtime=createTrustedAuthorizationRuntime({
  trustedApprovalKeys:[{key_id:"prod-test-key",approver_id:"security-owner",public_key_pem:publicKey.export({type:"spki",format:"pem"}),authorities:["repository.approve"]}],
  nonceStore:{consume:(keyId,nonce)=>{const id=keyId+":"+nonce;if(used.has(id))return false;used.add(id);return true;}},
  verifyEvidence,
  now:()=>now
 });
 assert.equal(runtime.keyCount,1);
 assert.equal(runtime.evaluate(writeTask({constraints:{provider:"github",branch:"other"}}),[evidence()],writeContext(),{approval:signed}).decision,"DENY");
 assert.equal(used.size,0);
 assert.equal(runtime.evaluate(writeTask(),[evidence()],writeContext(),{approval:signed}).decision,"ALLOW");
 assert.equal(runtime.evaluate(writeTask(),[evidence()],writeContext(),{approval:signed}).decision,"DENY");
});
test("trusted composition root rejects forged signatures, unknown keys and approver authority mismatches",()=>{
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 const unsigned=approvalArtifact({key_id:"trusted-key",signature:"placeholder"});
 const payload=canonicalApprovalPayload(unsigned);
 const signed={...unsigned,signature:sign(null,Buffer.from(payload,"utf8"),privateKey).toString("base64url")};
 const runtime=createTrustedAuthorizationRuntime({
  trustedApprovalKeys:[{key_id:"trusted-key",approver_id:"security-owner",public_key_pem:publicKey.export({type:"spki",format:"pem"}),authorities:["repository.approve"]}],
  nonceStore:{consume:()=>true},verifyEvidence,now:()=>now
 });
 assert.equal(runtime.evaluate(writeTask(),[evidence()],writeContext(),{approval:{...signed,signature:"A".repeat(86)}}).decision,"DENY");
 assert.equal(runtime.evaluate(writeTask(),[evidence()],writeContext(),{approval:{...signed,key_id:"unknown-key"}}).decision,"DENY");
 const wrongApprover={...unsigned,approved_by:"untrusted-user"};
 const wrongPayload=canonicalApprovalPayload(wrongApprover);
 const wrongSigned={...wrongApprover,signature:sign(null,Buffer.from(wrongPayload,"utf8"),privateKey).toString("base64url")};
 assert.equal(runtime.evaluate(writeTask(),[evidence()],writeContext(),{approval:wrongSigned}).decision,"DENY");
});
test("trusted runtime rejects a clock that throws or returns non-finite values at construction",()=>{
 const {publicKey}=generateKeyPairSync("ed25519");
 const key={key_id:"clock-init-key",approver_id:"security-owner",public_key_pem:publicKey.export({type:"spki",format:"pem"}),authorities:["repository.approve"]};
 const dependencies={trustedApprovalKeys:[key],nonceStore:{consume:()=>true},verifyEvidence};
 assert.throws(()=>createTrustedAuthorizationRuntime({...dependencies,now:()=>{throw new Error("clock unavailable");}}),/TRUSTED_CLOCK_UNAVAILABLE/);
 assert.throws(()=>createTrustedAuthorizationRuntime({...dependencies,now:()=>Number.NaN}),/TRUSTED_CLOCK_UNAVAILABLE/);
 assert.throws(()=>createTrustedAuthorizationRuntime({...dependencies,now:()=>"not-a-number"}),/TRUSTED_CLOCK_UNAVAILABLE/);
});

test("trusted composition root rejects asynchronous nonce adapters and missing trusted clock",()=>{
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 const key={key_id:"clock-key",approver_id:"security-owner",public_key_pem:publicKey.export({type:"spki",format:"pem"}),authorities:["repository.approve"]};
 assert.throws(()=>createTrustedAuthorizationRuntime({trustedApprovalKeys:[key],nonceStore:{consume:()=>true},verifyEvidence}),/TRUSTED_CLOCK_REQUIRED/);
 const unsigned=approvalArtifact({key_id:"clock-key",nonce:"async-nonce",signature:"placeholder"});
 const payload=canonicalApprovalPayload(unsigned);
 const signed={...unsigned,signature:sign(null,Buffer.from(payload,"utf8"),privateKey).toString("base64url")};
 const runtime=createTrustedAuthorizationRuntime({trustedApprovalKeys:[key],nonceStore:{consume:async()=>true},verifyEvidence,now:()=>now});
 assert.equal(runtime.evaluate(writeTask(),[evidence()],writeContext(),{approval:signed}).decision,"DENY");
});
test("trusted composition root requires explicit keyring, nonce store and evidence verifier",()=>{
 assert.throws(()=>createTrustedAuthorizationRuntime({nonceStore:{consume:()=>true},verifyEvidence,now:()=>now}),/TRUSTED_APPROVAL_KEYRING_REQUIRED/);
 assert.throws(()=>createTrustedAuthorizationRuntime({trustedApprovalKeys:[],nonceStore:{consume:()=>true},verifyEvidence,now:()=>now}),/TRUSTED_APPROVAL_KEYRING_REQUIRED/);
 assert.throws(()=>createTrustedAuthorizationRuntime({trustedApprovalKeys:[{key_id:"k",approver_id:"a",public_key_pem:"invalid",authorities:["repository.approve"]}],nonceStore:{consume:()=>true},verifyEvidence,now:()=>now}),/TRUSTED_APPROVAL_PUBLIC_KEY_INVALID/);
 assert.throws(()=>createTrustedAuthorizationRuntime({trustedApprovalKeys:[{key_id:"k",approver_id:"a",public_key_pem:"invalid",authorities:["repository.approve"]}]}),/DURABLE_NONCE_STORE_REQUIRED/);
});
test("approval nonce is not consumed when required evidence is missing",()=>{
 const t=writeTask(),c=writeContext(),a=approvalArtifact(),used=new Set(),verifier=approvalVerifierFor(a,used);
 const result=evaluatePolicy(t,[],c,{now,approvalVerifier:verifier,approval:a});
 assert.equal(result.decision,"INSUFFICIENT_EVIDENCE");
 assert.equal(used.size,0);
});
test("external write requires a request-bound signed approval artifact",()=>{
 const t=writeTask(), c=writeContext(), a=approvalArtifact();
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence}).decision,"DENY");
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"ALLOW");
 const reject=createRequestBoundApprovalVerifier({now:()=>now,verifySignature:()=>false,consumeNonce:()=>true});
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:reject,approval:a}).decision,"DENY");
});
test("approval artifact cannot be substituted with a caller boolean or malformed object",()=>{
 const t=writeTask(),c=writeContext();
 const valid=approvalArtifact(), verifier=approvalVerifierFor(valid);
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:verifier,approval:{approved:true}}).decision,"DENY");
 const a=approvalArtifact({signature:""});
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"DENY");
});
test("approval binding rejects wrong task, actor, provider, operation and target",()=>{
 const c=writeContext(), a=approvalArtifact();
 const verify=approvalVerifierFor(a);
 const cases=[
  [writeTask({task_id:"task-other"}),a],
  [writeTask({actor:"other-actor"}),a],
  [writeTask({constraints:{provider:"gitlab"}}),a],
  [writeTask({action:"repo.delete"}),a],
  [writeTask({target:{resource_type:"repository",resource_id:"OTHER"}}),a]
 ];
 for(const [t,approval] of cases) assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:verify,approval}).decision,"DENY");
});
test("approval is bound to the complete canonical task including constraints",()=>{
 const t=writeTask({constraints:{provider:"github",branch:"release"}}),c=writeContext(),a=approvalArtifact();
 const verify=approvalVerifierFor(a);
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:verify,approval:a}).decision,"DENY");
});
test("approval authority must match the policy authority",()=>{
 const t=writeTask(),c=writeContext(),a=approvalArtifact({authority:"unrelated.authority"});
 const verify=createRequestBoundApprovalVerifier({
  now:()=>now,verifySignature:(payload,signature)=>signature==="test-signature" && payload===canonicalApprovalPayload(a),
  consumeNonce:()=>true
 });
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:verify,approval:a}).decision,"DENY");
});
test("approval expiry, excessive lifetime and missing provider fail closed",()=>{
 const c=writeContext(), expired=approvalArtifact({expires_at:"2026-11-04T06:59:59Z"});
 assert.equal(evaluatePolicy(writeTask(),[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(expired),approval:expired}).decision,"DENY");
 const long=approvalArtifact({expires_at:"2026-11-04T07:06:00Z"});
 assert.equal(evaluatePolicy(writeTask(),[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(long),approval:long}).decision,"DENY");
 const a=approvalArtifact();
 assert.equal(evaluatePolicy(writeTask({constraints:{}}),[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"DENY");
});
test("approval nonce is consumed once and replay is denied",()=>{
 const t=writeTask(),c=writeContext(),a=approvalArtifact(),used=new Set(),approvalVerifier=approvalVerifierFor(a,used);
 const options={now,verifyEvidence,approvalVerifier,approval:a};
 assert.equal(evaluatePolicy(t,[evidence()],c,options).decision,"ALLOW");
 assert.equal(evaluatePolicy(t,[evidence()],c,options).decision,"DENY");
});
test("cancelled task overrides an otherwise valid policy",()=>{
 assert.equal(evaluatePolicy(task({status:"CANCELLED"}),[],context(),{now}).decision,"DENY");
});
test("ambiguous policy rules fail closed",()=>{
 const rules=[...context().policies,{...context().policies[0],required_authority:"different.authority"}];
 assert.equal(evaluatePolicy(task(),[],context({policies:rules}),{now}).decision,"BLOCKED");
});
test("policy evaluator fails closed when trusted time is absent or invalid",()=>{
 const validTask=task(), validContext=context();
 assert.equal(evaluatePolicy(validTask,[],validContext,{}).decision,"BLOCKED");
 assert.equal(evaluatePolicy(validTask,[],validContext,{now:Number.NaN}).decision,"BLOCKED");
 assert.equal(evaluatePolicy(validTask,[],validContext,{now:"not-a-number"}).decision,"BLOCKED");
});
test("expired trusted context blocks",()=>{
 assert.equal(evaluatePolicy(task(),[],context({evaluated_at:"2026-11-04T06:00:00Z"}),{now}).decision,"BLOCKED");
});
test("memory ledger rejects duplicate IDs and verifies entries",()=>{const m=new MemoryLedger();assert.equal(m.append({id:"m1",kind:"finding",createdAt:at,payload:{sha:"abc"}}).ok,true);assert.equal(m.append({id:"m1",kind:"finding",createdAt:at,payload:{sha:"x"}}).reason,"DUPLICATE_MEMORY_ID");assert.equal(m.verify().ok,true);});
test("Saga state machine rejects invalid transitions",()=>{let s=createSaga({id:"s1",goal:"audit",createdAt:at});s=transitionSaga(s,"RUNNING",{id:"e1",at,kind:"start"}).value;assert.equal(transitionSaga(s,"PENDING",{id:"e2",at,kind:"rewind"}).reason,"INVALID_STATE_TRANSITION");});
test("agent registry prevents privilege escalation",()=>{const a=new AgentRegistry();assert.equal(a.registerAgent({id:"builder",scopes:["repository.read"],status:"active"}).ok,true);assert.equal(a.registerAgent({id:"root",scopes:["production.deploy"],status:"active"}).reason,"INVALID_AGENT");a.registerTool({name:"read",requiredScopes:["repository.read"]});assert.equal(a.authorize("builder","read","repository.read").allowed,true);assert.equal(a.authorize("builder","read","production.deploy").allowed,false);});
test("request-bound approval verifier fails closed when its trusted clock throws",()=>{
 const verifier=createRequestBoundApprovalVerifier({
  now:()=>{throw new Error("clock unavailable");},
  verifySignature:()=>true,
  consumeNonce:()=>true
 });
 const artifact=approvalArtifact();
 assert.equal(verifier(artifact,{
  task_id:artifact.task_id,actor:artifact.actor,provider:artifact.provider,
  operation:artifact.operation,target:artifact.target,authority:artifact.authority,
  request_digest:artifact.request_digest
 }),false);
});

test("Saga event history is deeply immutable after transitions",()=>{
 let s=createSaga({id:"s2",goal:"audit",createdAt:at});
 s=transitionSaga(s,"RUNNING",{id:"e2",at,kind:"start",meta:{source:"telegram"}}).value;
 assert.equal(Object.isFrozen(s),true);
 assert.equal(Object.isFrozen(s.events),true);
 assert.equal(Object.isFrozen(s.events[0]),true);
 assert.equal(Object.isFrozen(s.events[0].meta),true);
 assert.throws(()=>s.events.push({id:"e3",at,kind:"tamper"}),TypeError);
 assert.throws(()=>{s.events[0].meta.source="tampered";},TypeError);
});

test("policy rules with the same action are scoped by target type",()=>{
 const policies=[
  {action:"resource.read",required_authority:"repository.read",target_types:["repository"],side_effect_class:"READ_ONLY"},
  {action:"resource.read",required_authority:"telegram.read",target_types:["telegram_update"],side_effect_class:"READ_ONLY"}
 ];
 const t=task({action:"resource.read"});
 assert.equal(evaluatePolicy(t,[],context({policies}),{now}).decision,"ALLOW");
 const wrong=task({action:"resource.read",target:{resource_type:"file",resource_id:"KRATT-PRIME"}});
 assert.equal(evaluatePolicy(wrong,[],context({policies}),{now}).reasons[0],"TARGET_TYPE_NOT_ALLOWED");
});
test("LOCAL_WRITE honours policy approval requirement",()=>{
 const t=writeTask();
 const c=context({policies:[{action:"repo.write",required_authority:"repository.read",target_types:["repository"],side_effect_class:"LOCAL_WRITE",approval_required:true,approval_authority:"repository.approve",required_claims:["TESTS_PASSED"]}]});
 const a=approvalArtifact();
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence}).decision,"DENY");
 assert.equal(evaluatePolicy(t,[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"ALLOW");
});
test("write evidence requirements come from trusted policy and bind to target",()=>{
 const t=writeTask(), c=writeContext(), a=approvalArtifact();
 const wrongSubject={...evidence(),subject:"another-repository"};
 assert.equal(evaluatePolicy(t,[wrongSubject],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"INSUFFICIENT_EVIDENCE");
 const weakened={...t,required_evidence:[]};
 assert.equal(evaluatePolicy(weakened,[evidence()],c,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"DENY");
 const noPolicyClaim={...c,policies:[{...c.policies[0],required_claims:[]}]};
 assert.equal(evaluatePolicy(t,[evidence()],noPolicyClaim,{now,verifyEvidence,approvalVerifier:approvalVerifierFor(a),approval:a}).decision,"BLOCKED");
});
