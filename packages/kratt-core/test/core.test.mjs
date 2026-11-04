import test from "node:test";
import assert from "node:assert/strict";
import { KRATT_SCHEMA_VERSION, validateApprovalArtifact, validateTaskEnvelope } from "../src/contracts.mjs";
import { evaluatePolicy } from "../src/policy.mjs";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { createSaga, transitionSaga } from "../src/saga.mjs";
import { AgentRegistry } from "../src/agent-registry.mjs";

const at = "2026-11-04T08:00:00Z";
const now = Date.parse(at);
const task = (overrides = {}) => ({
  schema_version:KRATT_SCHEMA_VERSION,
  task_id:"task-1",
  actor:"builder",
  action:"repo.read",
  target:{resource_type:"repository",resource_id:"KRATT-PRIME"},
  constraints:{branch:"integration"},
  required_evidence:[],
  created_at:at,
  requested_authority:["admin"],
  status:"PENDING",
  ...overrides
});
const context = (overrides = {}) => ({
  schema_version:KRATT_SCHEMA_VERSION,
  authorities:["repository.read","repository.write"],
  allowed_targets:[{resource_type:"repository",resource_id:"KRATT-PRIME",branch:"integration"}],
  policies:[
    {action:"repo.read",required_authority:"repository.read",target_types:["repository"],side_effect:"READ_ONLY"},
    {action:"repo.write",required_authority:"repository.write",target_types:["repository"],side_effect:"EXTERNAL_WRITE",provider:"github"}
  ],
  evaluated_at:at,
  expires_at:"2026-11-04T08:05:00Z",
  kill_switch:false,
  ...overrides
});
const options = extra => ({now,maxContextAgeMs:5*60*1000,...extra});
const approval = (overrides = {}) => ({
  approval_id:"approval-1",
  task_id:"task-1",
  actor:"builder",
  provider:"github",
  operation:"repo.write",
  target:{resource_type:"repository",resource_id:"KRATT-PRIME"},
  issued_at:"2026-11-04T07:59:00Z",
  expires_at:"2026-11-04T08:01:00Z",
  status:"APPROVED",
  nonce:"nonce-1",
  ...overrides
});
const evidence = (overrides = {}) => ({
  schema_version:KRATT_SCHEMA_VERSION,
  evidence_id:"evidence-1",
  subject:"KRATT-PRIME",
  claim_type:"TESTS_PASSED",
  source:{source_type:"github-actions",source_id:"run-1",revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  observed_at:at,
  verification_method:"trusted-ci-verifier",
  result:"VERIFIED",
  artifact_digest:null,
  metadata:{},
  ...overrides
});

test("task contract rejects unrecognized privilege fields",()=>{
  assert.equal(validateTaskEnvelope(task()).ok,true);
  assert.equal(validateTaskEnvelope({...task(),admin:true}).ok,false);
});
test("read-only policy uses trusted authority and exact target scope",()=>{
  assert.equal(evaluatePolicy(task(),[],context(),options()).decision,"ALLOW");
  assert.equal(evaluatePolicy(task(),[],context({authorities:[]}),options()).decision,"DENY");
  assert.equal(evaluatePolicy(task({target:{resource_type:"repository",resource_id:"OTHER"}}),[],context(),options()).decision,"DENY");
});
test("invalid trusted context blocks",()=>{
  assert.equal(evaluatePolicy(task(),[],null,options()).decision,"BLOCKED");
});
test("cancelled and already evaluated tasks cannot be authorized",()=>{
  assert.equal(evaluatePolicy(task({status:"CANCELLED"}),[],context(),options()).reasons[0],"TASK_CANCELLED");
  assert.equal(evaluatePolicy(task({status:"EVALUATED"}),[],context(),options()).reasons[0],"TASK_NOT_PENDING");
});
test("kill switch overrides a valid read policy",()=>{
  const result=evaluatePolicy(task(),[],context({kill_switch:true}),options());
  assert.equal(result.decision,"DENY");
  assert.equal(result.reasons[0],"GLOBAL_KILL_SWITCH_ACTIVE");
});
test("stale, future and expired trusted context is blocked",()=>{
  assert.equal(evaluatePolicy(task(),[],context({evaluated_at:"2026-11-04T07:00:00Z"}),options()).decision,"BLOCKED");
  assert.equal(evaluatePolicy(task(),[],context({evaluated_at:"2026-11-04T08:01:00Z"}),options()).decision,"BLOCKED");
  assert.equal(evaluatePolicy(task(),[],context({expires_at:at}),options()).decision,"BLOCKED");
});
test("ambiguous policy rules fail closed",()=>{
  const c=context({policies:[...context().policies,{action:"repo.read",required_authority:"repository.write",target_types:["repository"],side_effect:"READ_ONLY"}]});
  assert.equal(evaluatePolicy(task(),[],c,options()).reasons[0],"POLICY_CONFLICT");
});
test("branch and path constraints must intersect trusted target scope",()=>{
  const t=task({constraints:{branch:"main"}});
  assert.equal(evaluatePolicy(t,[],context(),options()).reasons[0],"TARGET_OUT_OF_SCOPE");
});
test("external write without request-bound approval is denied even with no required evidence",()=>{
  const t=task({action:"repo.write"});
  assert.equal(evaluatePolicy(t,[],context(),options()).reasons[0],"MISSING_OR_INVALID_REQUEST_BOUND_APPROVAL");
});
test("approval is bound to task, actor, provider, operation, target and expiry",()=>{
  const t=task({action:"repo.write"});
  assert.equal(evaluatePolicy(t,[],context(),options({approval:approval(),verifyApproval:()=>true})).decision,"ALLOW");
  assert.equal(evaluatePolicy(t,[],context(),options({approval:approval({task_id:"other-task"}),verifyApproval:()=>true})).decision,"DENY");
  assert.equal(evaluatePolicy(t,[],context(),options({approval:approval({provider:"other-provider"}),verifyApproval:()=>true})).decision,"DENY");
  assert.equal(evaluatePolicy(t,[],context(),options({approval:approval({expires_at:at}),verifyApproval:()=>true})).decision,"DENY");
});
test("caller-supplied approval is not trusted without a trusted verifier",()=>{
  const t=task({action:"repo.write"});
  assert.equal(evaluatePolicy(t,[],context(),options({approval:approval()})).decision,"DENY");
  assert.equal(evaluatePolicy(t,[],context(),options({approval:approval(),verifyApproval:()=>{throw new Error("bad verifier");}})).decision,"DENY");
});
test("caller-supplied VERIFIED evidence cannot satisfy a requirement without trusted verification",()=>{
  const t=task({required_evidence:[{claim_type:"TESTS_PASSED",subject:"KRATT-PRIME",required:true,revision:null}]});
  assert.equal(evaluatePolicy(t,[evidence()],context(),options()).decision,"INSUFFICIENT_EVIDENCE");
  assert.equal(evaluatePolicy(t,[evidence()],context(),options({verifyEvidence:()=>true})).decision,"ALLOW");
});
test("approval contract rejects malformed and non-approved artifacts",()=>{
  assert.equal(validateApprovalArtifact(approval()).ok,true);
  assert.equal(validateApprovalArtifact(approval({status:"REVOKED"})).ok,false);
});
test("duplicate evidence IDs are rejected",()=>{
  const e=evidence();
  assert.equal(evaluatePolicy(task(),[e,e],context(),options()).reasons[0],"DUPLICATE_EVIDENCE_ID");
});
test("memory ledger rejects duplicate IDs and verifies entries",()=>{
  const m=new MemoryLedger();
  assert.equal(m.append({id:"m1",kind:"finding",createdAt:at,payload:{sha:"abc"}}).ok,true);
  assert.equal(m.append({id:"m1",kind:"finding",createdAt:at,payload:{sha:"x"}}).reason,"DUPLICATE_MEMORY_ID");
  assert.equal(m.verify().ok,true);
});
test("Saga state machine rejects invalid transitions",()=>{
  let s=createSaga({id:"s1",goal:"audit",createdAt:at});
  s=transitionSaga(s,"RUNNING",{id:"e1",at,kind:"start"}).value;
  assert.equal(transitionSaga(s,"PENDING",{id:"e2",at,kind:"rewind"}).reason,"INVALID_STATE_TRANSITION");
});
test("agent registry prevents privilege escalation",()=>{
  const a=new AgentRegistry();
  assert.equal(a.registerAgent({id:"builder",scopes:["repository.read"],status:"active"}).ok,true);
  assert.equal(a.registerAgent({id:"root",scopes:["production.deploy"],status:"active"}).reason,"INVALID_AGENT");
  a.registerTool({name:"read",requiredScopes:["repository.read"]});
  assert.equal(a.authorize("builder","read","repository.read").allowed,true);
  assert.equal(a.authorize("builder","read","production.deploy").allowed,false);
});
