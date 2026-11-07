import test from "node:test"; import assert from "node:assert/strict";
import { validateHardwareSnapshot, proposeComputeRoute, classifyRuntimeState, HARDWARE_CONTRACT_VERSION } from "../src/hardware-capabilities.mjs";
const snapshot={schemaVersion:HARDWARE_CONTRACT_VERSION,platform:"linux",architecture:"x64",observedAt:Date.now(),devices:[{id:"cpu0",kind:"CPU",state:"AVAILABLE",backends:[{id:"cpu-backend",kind:"onnxruntime",state:"AVAILABLE",stages:["DECODE"]}]}]};
test("validates immutable hardware snapshot",()=>{const r=validateHardwareSnapshot(snapshot);assert.equal(r.ok,true);assert.equal(Object.isFrozen(r.snapshot.devices),true);});
test("rejects malformed hardware snapshot",()=>{assert.equal(validateHardwareSnapshot({...snapshot,devices:[{...snapshot.devices[0],kind:"REMOTE"}]}).ok,false);});
test("routes locally as proposal and never executes",()=>{const r=proposeComputeRoute({snapshot,stage:"DECODE",allowedBackends:["CPU"],requireLocal:true});assert.equal(r.proposal.state,"PROPOSED");assert.equal(r.proposal.executionStarted,false);});
test("does not silently fall back to remote",()=>{const r=proposeComputeRoute({snapshot:{...snapshot,devices:[]},stage:"DECODE",allowedBackends:["REMOTE"],requireLocal:true});assert.equal(r.proposal.state,"BLOCKED");});
test("labels configuration honestly",()=>{assert.equal(classifyRuntimeState({adapterConfigured:true,snapshot,route:{proposal:{state:"PROPOSED"}}}),"ROUTE_PROPOSED_NOT_EXECUTED");});
