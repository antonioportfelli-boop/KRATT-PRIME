/**
 * KRATT PRIME — five-plane runtime planner.
 * Joins host, network, hardware, adapters, policy and evidence into a reviewable plan.
 * A plan is not an execution receipt.
 */
import { validateHardwareSnapshot, proposeComputeRoute } from "./hardware-capabilities.mjs";
import { createAdaptiveBootstrapPlan } from "./adaptive-bootstrap.mjs";
import { validateAdapterManifest } from "./adapter-registry.mjs";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA=/^[0-9a-f]{40}$/;
const TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&
  (Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const bad=reason=>Object.freeze({ok:false,reason});
export function createRuntimeAssessment(input={}) {
  const {taskId,sourceRevision,now,hostProfile,hardwareSnapshot,stage="PREFILL",
    allowedBackends=["CPU"],adapterManifests=[],trustedPolicyDecision=null,requiredEvidence=[]}=input;
  if(typeof taskId!=="string"||!ID.test(taskId)||
     typeof sourceRevision!=="string"||!SHA.test(sourceRevision)||
     typeof now!=="string"||!TIME.test(now)||!Number.isFinite(Date.parse(now)))
    return bad("RUNTIME_ASSESSMENT_INPUT_INVALID");
  if(!hostProfile?.ok || !hostProfile.profile) return bad("HOST_PROFILE_REQUIRED");
  if(!Array.isArray(adapterManifests)||adapterManifests.length>64) return bad("ADAPTER_LIST_INVALID");
  if(!Array.isArray(requiredEvidence)||requiredEvidence.length>64||
     requiredEvidence.some(x=>typeof x!=="string"||x.length>192)) return bad("REQUIRED_EVIDENCE_INVALID");
  const adapters=[],seen=new Set();
  for(const manifest of adapterManifests) {
    const checked=validateAdapterManifest(manifest);
    if(!checked.ok) return bad("ADAPTER_MANIFEST_INVALID:"+checked.reason);
    if(seen.has(checked.manifest.adapterId)) return bad("ADAPTER_DUPLICATE");
    seen.add(checked.manifest.adapterId);
    adapters.push(Object.freeze({
      adapterId:checked.manifest.adapterId,provider:checked.manifest.provider,
      state:checked.manifest.state,
      enabledReadOps:checked.manifest.capabilities.filter(c=>c.enabled&&["READ_ONLY","SENSITIVE_READ"].includes(c.sideEffect)).length,
      writeEnabled:checked.manifest.state==="WRITE_ENABLED"
    }));
  }
  const policyValid=plain(trustedPolicyDecision) &&
    trustedPolicyDecision.taskId===taskId &&
    ["ALLOW","DENY","BLOCKED","INSUFFICIENT_EVIDENCE"].includes(trustedPolicyDecision.decision) &&
    typeof trustedPolicyDecision.decisionId==="string" && ID.test(trustedPolicyDecision.decisionId) &&
    typeof trustedPolicyDecision.evaluatedAt==="string" && TIME.test(trustedPolicyDecision.evaluatedAt);
  const policyState=policyValid?trustedPolicyDecision.decision:"BLOCKED";
  const checkedHardware=validateHardwareSnapshot(hardwareSnapshot);
  const route=checkedHardware.ok?proposeComputeRoute({
    snapshot:checkedHardware.snapshot,stage,allowedBackends,
    requireLocal:!allowedBackends.includes("REMOTE")
  }):bad(checkedHardware.reason);
  const bootstrap=createAdaptiveBootstrapPlan(hostProfile);
  const blockers=[];
  if(!policyValid) blockers.push("TRUSTED_POLICY_DECISION_REQUIRED");
  else if(policyState!=="ALLOW") blockers.push("POLICY_"+policyState);
  if(!checkedHardware.ok) blockers.push("HARDWARE_SNAPSHOT_"+checkedHardware.reason);
  if(!route.ok) blockers.push("COMPUTE_ROUTE_"+route.reason);
  if(hostProfile.readiness==="PARTIAL_REVIEW_REQUIRED") blockers.push(...hostProfile.reviewReasons);
  if(route.ok && route.proposal?.target==="REMOTE") blockers.push("REMOTE_DATA_TRANSFER_APPROVAL_REQUIRED");
  const state=blockers.length?"BLOCKED":"PLAN_PROPOSED";
  return Object.freeze({ok:true,plan:Object.freeze({
    schemaVersion:"kratt-runtime-plan/v1",planId:"runtime:"+taskId,
    taskId,sourceRevision,createdAt:now,state,
    planes:Object.freeze({
      host:"OBSERVED",
      network:hostProfile.profile.network.managementState,
      hardware:checkedHardware.ok?"VALIDATED":"UNAVAILABLE",
      adapters:"DECLARATIVE_ONLY",
      policy:policyState,
      evidence:requiredEvidence.length?"REQUIREMENTS_DECLARED":"NO_EXTRA_REQUIREMENTS"
    }),
    computeRoute:route.ok?route.proposal:null,
    adapterInventory:Object.freeze(adapters),
    bootstrapPlan:bootstrap.ok?bootstrap:null,
    requiredEvidence:Object.freeze([...new Set(requiredEvidence)]),
    blockers:Object.freeze([...new Set(blockers)]),
    execution:Object.freeze({
      state:"NOT_STARTED",executionStarted:false,externalEffects:false,
      hostChanges:false,providerWrites:false
    })
  })});
}
