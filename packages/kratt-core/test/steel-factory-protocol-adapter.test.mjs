import test from "node:test";
import assert from "node:assert/strict";
import { createSteelFactoryProtocolAdapter } from "../src/steel-factory-protocol-adapter.mjs";
import { validateTaskEnvelope } from "../src/contracts.mjs";
const at="2026-11-18T16:00:00.000Z",sha="0123456789012345678901234567890123456789";
const envelope={task_id:"factory-task-01",factory:"FORGE",agent_id:"FORGE-001",objective:"Update and validate a repository module",
 repository:"3XTRINITY/KRATT-PRIME",branch:"feature/example",base_sha:sha,scope:["packages/core/a.mjs"],
 allowed_actions:["repo:write"],forbidden_actions:["production:deploy"],required_evidence:["tests_passed"],
 resource_budget:{max_wall_ms:60000,max_output_bytes:65536,max_files:5},protocol_version:1};
const receipt={task_id:envelope.task_id,agent_id:envelope.agent_id,repository:envelope.repository,base_sha:sha,
 action:"repo:write",scope:["packages/core/a.mjs"],result:{ok:true,exit_code:0,checks:{pass:12,fail:0},failure:null},
 evidence:{toepara:{verdict:"VERIFIED"}},verification_state:"VERIFIED",timestamp:at,protocol_version:1};
test("maps a scoped STEEL factory task to a strict KRATT task",()=>{
 const adapter=createSteelFactoryProtocolAdapter({verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"}});
 const mapped=adapter.adaptTask({envelope,action:"repo:write",scope:envelope.scope,actor:"FORGE-001",createdAt:at});
 assert.equal(mapped.ok,true);assert.equal(validateTaskEnvelope(mapped.task).ok,true);
 assert.equal(mapped.task.required_evidence[0].claim_type,"TESTS_PASSED");
 assert.equal(mapped.task.constraints.repository,envelope.repository);
});
test("rejects forbidden actions, scope expansion and missing evidence mappings",()=>{
 const adapter=createSteelFactoryProtocolAdapter({verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"}});
 assert.equal(adapter.adaptTask({envelope,action:"production:deploy",scope:envelope.scope,actor:"FORGE-001",createdAt:at}).ok,false);
 assert.equal(adapter.adaptTask({envelope,action:"repo:write",scope:["outside/file.mjs"],actor:"FORGE-001",createdAt:at}).ok,false);
 const noMap=createSteelFactoryProtocolAdapter({verifyActionReceipt:async()=>true});
 assert.equal(noMap.adaptTask({envelope,action:"repo:write",scope:envelope.scope,actor:"FORGE-001",createdAt:at}).reason,"STEEL_EVIDENCE_CLAIM_MAPPING_REQUIRED");
});
test("receipt must bind task, branch base, action and scope and pass independent verification",async()=>{
 let calls=0;const adapter=createSteelFactoryProtocolAdapter({verifyActionReceipt:async()=>{calls++;return true;},evidenceClaimMap:{tests_passed:"TESTS_PASSED"}});
 const verified=await adapter.verifyReceipt({envelope,receipt,expectedAction:"repo:write",expectedScope:envelope.scope});
 assert.equal(verified.ok,true);assert.match(verified.receipt_digest,/^sha256:/);assert.equal(calls,1);
 const altered={...receipt,base_sha:"ffffffffffffffffffffffffffffffffffffffff"};
 const rejected=await adapter.verifyReceipt({envelope,receipt:altered,expectedAction:"repo:write",expectedScope:envelope.scope});
 assert.equal(rejected.reason,"STEEL_RECEIPT_BINDING_MISMATCH");
});
test("receipt claims are not accepted from the protocol flag alone",async()=>{
 const adapter=createSteelFactoryProtocolAdapter({verifyActionReceipt:async()=>false,evidenceClaimMap:{tests_passed:"TESTS_PASSED"}});
 const rejected=await adapter.verifyReceipt({envelope,receipt,expectedAction:"repo:write",expectedScope:envelope.scope});
 assert.equal(rejected.reason,"STEEL_RECEIPT_NOT_INDEPENDENTLY_VERIFIED");
});


test("rejects impossible calendar timestamps in STEEL action receipts",async()=>{
 const adapter=createSteelFactoryProtocolAdapter({verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"}});
 const invalid={...receipt,timestamp:"2026-02-30T16:00:00.000Z"};
 const result=await adapter.verifyReceipt({envelope,receipt:invalid,expectedAction:"repo:write",expectedScope:envelope.scope});
 assert.equal(result.reason,"STEEL_PROTOCOL_INPUT_INVALID");
});


test("rejects invisible and bidirectional override characters in task objectives", () => {
 const adapter=createSteelFactoryProtocolAdapter({
  verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"},
 });
 for(const objective of ["update\u200b files","update\u202e files","update\ufeff files"]){
  const hostile={...envelope,objective};
  const result=adapter.adaptTask({envelope:hostile,action:"repo:write",scope:envelope.scope,actor:"FORGE-001",createdAt:at});
  assert.equal(result.reason,"STEEL_TASK_ENVELOPE_INVALID");
 }
});

test("nested receipt evidence accessors are rejected without invoking getters",async()=>{
 let getterCalls=0;
 const evidence={};
 Object.defineProperty(evidence,"claim",{
  enumerable:true,
  get(){getterCalls++;return "forged";}
 });
 const hostile={...receipt,evidence};
 const adapter=createSteelFactoryProtocolAdapter({
  verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"},
 });
 const result=await adapter.verifyReceipt({
  envelope,receipt:hostile,expectedAction:"repo:write",expectedScope:envelope.scope,
 });
 assert.equal(result.reason,"STEEL_PROTOCOL_INPUT_INVALID");
 assert.equal(getterCalls,0);
});

test("scope array accessors and holes are rejected before reading their values",()=>{
 let getterCalls=0;
 const scope=[];
 Object.defineProperty(scope,"0",{
  configurable:true,enumerable:true,
  get(){getterCalls++;return "packages/core/a.mjs";}
 });
 scope.length=1;
 const adapter=createSteelFactoryProtocolAdapter({
  verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"},
 });
 const result=adapter.adaptTask({
  envelope,action:"repo:write",scope,actor:"FORGE-001",createdAt:at,
 });
 assert.equal(result.ok,false);
 assert.equal(getterCalls,0);
});

test("expected receipt scope is snapshotted and accessor-backed scope is rejected",async()=>{
 let getterCalls=0;
 const expectedScope=[];
 Object.defineProperty(expectedScope,"0",{
  configurable:true,enumerable:true,
  get(){getterCalls++;return "packages/core/a.mjs";}
 });
 expectedScope.length=1;
 const adapter=createSteelFactoryProtocolAdapter({
  verifyActionReceipt:async()=>true,evidenceClaimMap:{tests_passed:"TESTS_PASSED"},
 });
 const result=await adapter.verifyReceipt({
  envelope,receipt,expectedAction:"repo:write",expectedScope,
 });
 assert.equal(result.reason,"STEEL_PROTOCOL_INPUT_INVALID");
 assert.equal(getterCalls,0);
});
