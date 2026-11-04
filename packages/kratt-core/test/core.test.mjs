import test from "node:test";
import assert from "node:assert/strict";
import { KRATT_SCHEMA_VERSION, validateTaskEnvelope } from "../src/contracts.mjs";
import { evaluatePolicy } from "../src/policy.mjs";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { createSaga, transitionSaga } from "../src/saga.mjs";
import { AgentRegistry } from "../src/agent-registry.mjs";

const at = "2026-11-04T08:00:00Z";
const task = (overrides = {}) => ({
  schema_version:KRATT_SCHEMA_VERSION,task_id:"task-1",actor:"builder",action:"repo.read",
  target:{resource_type:"repository",resource_id:"KRATT-PRIME"},constraints:{branch:"integration"},
  required_evidence:[],created_at:at,requested_authority:["admin"],status:"PENDING",...overrides
});
const context = (overrides = {}) => ({
  schema_version:KRATT_SCHEMA_VERSION,authorities:["repository.read"],
  allowed_targets:[{resource_type:"repository",resource_id:"KRATT-PRIME"}],
  policies:[{action:"repo.read",required_authority:"repository.read",target_types:["repository"],allowed_branches:["integration"],allowed_paths:["packages/kratt-core"]}],
  evaluated_at:at,...overrides
});
const now = at;
const writeTask = (overrides = {}) => task({
  action:"repo.write",constraints:{provider:"github",operation:"update_file",branch:"feature/wp-01-authorization-hardening",path:"packages/kratt-core/src/policy.mjs"},...overrides
});
const writeContext = (overrides = {}) => context({
  policies:[{action:"repo.write",required_authority:"repository.write",target_types:["repository"],side_effect_class:"WRITE",allowed_branches:["feature/wp-01-authorization-hardening"],allowed_paths:["packages/kratt-core"]}],
  authorities:["repository.write"],...overrides
});
const approval = (overrides = {}) => ({
  approval_id:"approval-1",request_id:"task-1",provider:"github",operation:"update_file",
  target:{resource_type:"repository",resource_id:"KRATT-PRIME"},
  branch:"feature/wp-01-authorization-hardening",path:"packages/kratt-core/src/policy.mjs",
  expires_at:"2026-11-04T09:00:00Z",...overrides
});
const approve = {now,approval:approval(),verifyApproval:()=>true};

test("task contract rejects unrecognized privilege fields",()=>{
  assert.equal(validateTaskEnvelope(task()).ok,true);
  assert.equal(validateTaskEnvelope({...task(),admin:true}).ok,false);
});
test("read policy uses trusted context, never task requested authority",()=>{
  assert.equal(evaluatePolicy(task(),[],context(),{now}).decision,"ALLOW");
  assert.equal(evaluatePolicy(task(),[],{...context(),authorities:[]},{now}).decision,"DENY");
  assert.equal(evaluatePolicy(task({target:{resource_type:"repository",resource_id:"OTHER"}}),[],context(),{now}).decision,"DENY");
});
test("invalid trusted context blocks",()=>assert.equal(evaluatePolicy(task(),[],null,{now}).decision,"BLOCKED"));
test("cancelled and already evaluated tasks cannot be allowed",()=>{
  assert.equal(evaluatePolicy(task({status:"CANCELLED"}),[],context(),{now}).decision,"DENY");
  assert.equal(evaluatePolicy(task({status:"EVALUATED"}),[],context(),{now}).decision,"DENY");
});
test("policy conflicts are order-independent and block",()=>{
  const conflicting = context({policies:[
    {action:"repo.read",required_authority:"repository.read",target_types:["repository"]},
    {action:"repo.read",required_authority:"admin",target_types:["repository"]}
  ]});
  assert.equal(evaluatePolicy(task(),[],conflicting,{now}).decision,"BLOCKED");
  assert.equal(evaluatePolicy(task(),[],{...conflicting,policies:[...conflicting.policies].reverse()},{now}).decision,"BLOCKED");
});
test("expired and future trusted contexts block",()=>{
  assert.equal(evaluatePolicy(task(),[],context({evaluated_at:"2026-11-04T07:58:59Z"}),{now}).decision,"BLOCKED");
  assert.equal(evaluatePolicy(task(),[],context({evaluated_at:"2026-11-04T08:00:01Z"}),{now}).decision,"BLOCKED");
});
test("branch and path must be inside trusted policy scope",()=>{
  assert.equal(evaluatePolicy(task({constraints:{branch:"main"}}),[],context(),{now}).decision,"DENY");
  assert.equal(evaluatePolicy(task({constraints:{branch:"integration",path:"../../.github"}}),[],context(),{now}).decision,"DENY");
});
test("write actions fail closed without a request-bound approval",()=>{
  assert.equal(evaluatePolicy(writeTask(),[],writeContext(),{now}).decision,"DENY");
  assert.equal(evaluatePolicy(writeTask(),[],writeContext(),{...approve,approval:null}).decision,"DENY");
  assert.equal(evaluatePolicy(writeTask(),[],writeContext(),{...approve,verifyApproval:undefined}).decision,"DENY");
});
test("approval is bound to request, provider, operation, target, branch, path and expiry",()=>{
  assert.equal(evaluatePolicy(writeTask(),[],writeContext(),approve).decision,"ALLOW");
  for (const changed of [
    {request_id:"other-task"},{provider:"gitlab"},{operation:"delete_repo"},
    {target:{resource_type:"repository",resource_id:"OTHER"}},
    {branch:"main"},{path:".github/workflows/ci.yml"},
    {expires_at:"2026-11-04T07:59:59Z"}
  ]) assert.equal(evaluatePolicy(writeTask(),[],writeContext(),{...approve,approval:approval(changed)}).decision,"DENY");
  assert.equal(evaluatePolicy(writeTask(),[],writeContext(),{...approve,verifyApproval:()=>false}).decision,"DENY");
});
test("caller-supplied VERIFIED evidence is not trusted without verifier",()=>{
  const evidence = {schema_version:KRATT_SCHEMA_VERSION,evidence_id:"ev-1",subject:"artifact-1",claim_type:"TESTS_PASSED",
    source:{source_type:"ci",source_id:"run-1",revision:null},observed_at:at,verification_method:"asserted",
    result:"VERIFIED",artifact_digest:null,metadata:{}};
  const required = task({required_evidence:[{claim_type:"TESTS_PASSED",subject:"artifact-1",required:true,revision:null}]});
  assert.equal(evaluatePolicy(required,[evidence],context(),{now}).decision,"INSUFFICIENT_EVIDENCE");
  assert.equal(evaluatePolicy(required,[evidence],context(),{now,verifyEvidence:()=>true}).decision,"ALLOW");
  assert.equal(evaluatePolicy(required,[evidence],context(),{now,verifyEvidence:()=>false}).decision,"INSUFFICIENT_EVIDENCE");
});
test("duplicate evidence identifiers are denied",()=>{
  const evidence = {schema_version:KRATT_SCHEMA_VERSION,evidence_id:"ev-1",subject:"artifact-1",claim_type:"TESTS_PASSED",
    source:{source_type:"ci",source_id:"run-1",revision:null},observed_at:at,verification_method:"asserted",
    result:"VERIFIED",artifact_digest:null,metadata:{}};
  assert.equal(evaluatePolicy(task(),[evidence,evidence],context(),{now}).decision,"DENY");
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
