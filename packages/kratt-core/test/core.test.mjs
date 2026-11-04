import test from "node:test";
import assert from "node:assert/strict";
import { KRATT_SCHEMA_VERSION, validateTaskEnvelope } from "../src/contracts.mjs";
import { evaluatePolicy, createRequestBoundApprovalVerifier, canonicalApprovalPayload, canonicalTaskDigest } from "../src/policy.mjs";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { createSaga, transitionSaga } from "../src/saga.mjs";
import { AgentRegistry } from "../src/agent-registry.mjs";

const at = "2026-11-04T07:00:00Z";
const now = Date.parse(at);
const task = (overrides={}) => ({schema_version:KRATT_SCHEMA_VERSION,task_id:"task-1",actor:"builder",action:"repo.read",target:{resource_type:"repository",resource_id:"KRATT-PRIME"},constraints:{branch:"integration"},required_evidence:[],created_at:at,requested_authority:["admin"],status:"PENDING",...overrides});
const context = (overrides={}) => ({schema_version:KRATT_SCHEMA_VERSION,authorities:["repository.read"],allowed_targets:[{resource_type:"repository",resource_id:"KRATT-PRIME"}],policies:[{action:"repo.read",required_authority:"repository.read",target_types:["repository"]}],evaluated_at:at,...overrides});
const evidence = () => ({schema_version:KRATT_SCHEMA_VERSION,evidence_id:"ev-1",subject:"repo-1",claim_type:"TESTS_PASSED",source:{source_type:"github",source_id:"run-1",revision:"0123456789012345678901234567890123456789"},observed_at:at,verification_method:"signed-attestation",result:"VERIFIED",artifact_digest:null,metadata:{}});
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
 const c=context({policies:[{action:"repo.write",required_authority:"repository.read",target_types:["repository"],side_effect_class:"EXTERNAL_WRITE",approval_required:true}]});
 assert.equal(evaluatePolicy(t,[],c,{now,approvalVerifier:()=>true}).decision,"DENY");
});
const writeTask = (overrides={}) => task({action:"repo.write",constraints:{provider:"github"},required_evidence:[{claim_type:"TESTS_PASSED",subject:"repo-1",required:true,revision:null}],...overrides});
const writeContext = () => context({policies:[{action:"repo.write",required_authority:"repository.read",target_types:["repository"],side_effect_class:"EXTERNAL_WRITE",approval_required:true}]});
const approvalArtifact = (overrides={}) => ({
 schema_version:KRATT_SCHEMA_VERSION,approval_id:"approval-1",task_id:"task-1",actor:"builder",
 provider:"github",operation:"repo.write",target:{resource_type:"repository",resource_id:"KRATT-PRIME"},
 request_digest:canonicalTaskDigest(writeTask()),nonce:"nonce-1",issued_at:at,expires_at:"2026-11-04T07:04:00Z",decision:"APPROVE",
 approved_by:"security-owner",authority:"repository.read",signature:"test-signature",...overrides
});
function approvalVerifierFor(artifact, consumed=new Set()) {
 return createRequestBoundApprovalVerifier({
  now:()=>now,
  verifySignature:(payload,signature)=>signature==="test-signature" && payload===canonicalApprovalPayload(artifact),
  consumeNonce:(nonce)=>{if(consumed.has(nonce))return false;consumed.add(nonce);return true;}
 });
}
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
test("expired trusted context blocks",()=>{
 assert.equal(evaluatePolicy(task(),[],context({evaluated_at:"2026-11-04T06:00:00Z"}),{now}).decision,"BLOCKED");
});
test("memory ledger rejects duplicate IDs and verifies entries",()=>{const m=new MemoryLedger();assert.equal(m.append({id:"m1",kind:"finding",createdAt:at,payload:{sha:"abc"}}).ok,true);assert.equal(m.append({id:"m1",kind:"finding",createdAt:at,payload:{sha:"x"}}).reason,"DUPLICATE_MEMORY_ID");assert.equal(m.verify().ok,true);});
test("Saga state machine rejects invalid transitions",()=>{let s=createSaga({id:"s1",goal:"audit",createdAt:at});s=transitionSaga(s,"RUNNING",{id:"e1",at,kind:"start"}).value;assert.equal(transitionSaga(s,"PENDING",{id:"e2",at,kind:"rewind"}).reason,"INVALID_STATE_TRANSITION");});
test("agent registry prevents privilege escalation",()=>{const a=new AgentRegistry();assert.equal(a.registerAgent({id:"builder",scopes:["repository.read"],status:"active"}).ok,true);assert.equal(a.registerAgent({id:"root",scopes:["production.deploy"],status:"active"}).reason,"INVALID_AGENT");a.registerTool({name:"read",requiredScopes:["repository.read"]});assert.equal(a.authorize("builder","read","repository.read").allowed,true);assert.equal(a.authorize("builder","read","production.deploy").allowed,false);});
