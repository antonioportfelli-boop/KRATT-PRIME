import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, evaluateAdapterOperation, validateAdapterManifest } from "../src/adapter-registry.mjs";
import { EvidenceLedger, verifyEvidenceChain } from "../src/evidence-ledger.mjs";
import { TemplateRegistry, BUILT_IN_TEMPLATE_IDS } from "../src/template-registry.mjs";
import { createWorkflowPlan, transitionWorkflowNode, workflowSummary } from "../src/workflow-orchestrator.mjs";
import { buildAdaptiveHostProfile, createAdaptiveBootstrapPlan } from "../src/adaptive-bootstrap.mjs";
import { createRuntimeAssessment } from "../src/runtime-orchestrator.mjs";
import { aggregateEvidenceMetrics } from "../src/metrics.mjs";
import { PROVIDER_CATALOG, providerInventory } from "../src/provider-catalog.mjs";
import { collectLinuxDiagnostics, LINUX_DIAGNOSTIC_COMMANDS } from "../src/linux-operations.mjs";

const now = "2026-11-07T03:30:00Z";
const later = "2026-11-07T03:35:00Z";
const revision = "a".repeat(40);

function readManifest() {
  return {
    schemaVersion:"kratt-adapter/v1",adapterId:"github.read.v1",provider:"github",
    version:"1.0.0",state:"VERIFIED_READ_ONLY",credentialRef:null,verifiedAt:now,
    allowedTargets:[{resourceType:"repository",resourceId:"KRATT-PRIME"}],
    capabilities:[{operationId:"repository.read",sideEffect:"READ_ONLY",
      requiredScopes:["repository.read"],targetTypes:["repository"],
      timeoutMs:5000,idempotent:true,enabled:true}]
  };
}
function writeManifest() {
  return {
    schemaVersion:"kratt-adapter/v1",adapterId:"linear.write.v1",provider:"linear",
    version:"1.0.0",state:"WRITE_ENABLED",credentialRef:"cred:linear-scoped",
    writeAuthorityRef:"authz:linear.issue.write",verifiedAt:now,
    allowedTargets:[{resourceType:"issue",resourceId:"STE-105"}],
    capabilities:[{operationId:"issue.comment",sideEffect:"EXTERNAL_WRITE",
      requiredScopes:["issue.comment"],targetTypes:["issue"],
      timeoutMs:5000,idempotent:true,enabled:true}]
  };
}
function diagnosticsReport({multipleManagers=false}={}) {
  const commands = [
    {id:"system.kernel",state:"OK",stdout:"Linux 6.8.0 x86_64"},
    {id:"system.cpu_count",state:"OK",stdout:"8"},
    {id:"system.cpu.details",state:"OK",stdout:JSON.stringify({lscpu:[
      {field:"Architecture:",data:"x86_64"},{field:"Model name:",data:"Test CPU"},
      {field:"Vendor ID:",data:"GenuineTest"},{field:"CPU(s):",data:"8"},
      {field:"Core(s) per socket:",data:"4"}
    ]})},
    {id:"system.memory",state:"OK",stdout:"total used free shared buff/cache available\nMem: 16000000000 1000000000 2000000000 100000000 1000000000 14000000000"},
    {id:"ip.addresses",state:"OK",stdout:JSON.stringify([{ifname:"eth0",operstate:"UP",addr_info:[{family:"inet"},{family:"inet6"}]}])},
    {id:"ip.routes.v4",state:"OK",stdout:JSON.stringify([{dst:"default",dev:"eth0"}])},
    {id:"ip.routes.v6",state:"OK",stdout:JSON.stringify([{dst:"::/0",dev:"eth0"}])},
    {id:"ip.route_get.v4",state:"OK",stdout:"[]"},
    {id:"ip.route_get.v6",state:"OK",stdout:"[]"},
    {id:"service.networkmanager",state:"OK",stdout:"active"},
    {id:"service.systemd_networkd",state:multipleManagers?"OK":"EXIT_NONZERO",stdout:multipleManagers?"active":"inactive"},
    {id:"service.connman",state:"EXIT_NONZERO",stdout:"inactive"},
    {id:"netctl.version",state:"UNAVAILABLE"}
  ];
  return {
    schemaVersion:"0.1.0",state:"COLLECTED_READ_ONLY",platform:"linux",
    collectedAt:now,osRelease:{ID:"debian",VERSION_ID:"13",PRETTY_NAME:"Debian Test"},
    packageManagers:["apt-get","pacman"],editors:["nano","micro"],developerTools:["bash","tmux"],
    networkManagerConfig:{mainConfigPresent:true,dropInDirectoryPresent:true,dropInFiles:["10-example.conf"],contentsRead:false,connectionProfilesRead:false},
    commands,privacy:{classification:"NETWORK_METADATA",autoUploadAllowed:false,exportRequiresApproval:true},
    writesPerformed:false,privilegedOperationsPerformed:false
  };
}
function hardwareSnapshot() {
  return {
    schemaVersion:"0.2.0",platform:"linux",architecture:"x86_64",observedAt:1794000000000,
    devices:[
      {id:"cpu0",kind:"CPU",state:"AVAILABLE",backends:[
        {id:"onnx-cpu",kind:"ONNXRuntime-CPU",state:"AVAILABLE",stages:["PREFILL","DECODE"]}]},
      {id:"gpu0",kind:"GPU",state:"AVAILABLE",backends:[
        {id:"vulkan",kind:"Vulkan",state:"AVAILABLE",stages:["PREFILL","DECODE","VISION"]}]}
    ]
  };
}
function hostProfile(multipleManagers=false) {
  return buildAdaptiveHostProfile(diagnosticsReport({multipleManagers}));
}
function trustedPolicy(decision="ALLOW") {
  return {taskId:"task-5x",decisionId:"decision:task-5x",decision,
    evaluatedAt:now,evidenceIds:["evidence:policy-1"]};
}

test("provider catalogue explicitly covers the named integration ecosystem without claiming connection",()=>{
  const ids=PROVIDER_CATALOG.map(x=>x.id);
  for(const id of ["github","slack","tinyfish","lovable","data","scispace","base44","linear","canva","template-creator"])
    assert.ok(ids.includes(id));
  const inventory=providerInventory([]);
  assert.equal(inventory.length,10);
  assert.ok(inventory.every(x=>x.state==="DISCOVERED" && x.writeEnabled===false));
});

test("adapter manifests are strictly validated and registry rejects duplicate identities",()=>{
  const registry=new AdapterRegistry();
  assert.equal(validateAdapterManifest(readManifest()).ok,true);
  assert.equal(registry.register(readManifest()).ok,true);
  assert.equal(registry.register(readManifest()).reason,"ADAPTER_ALREADY_REGISTERED");
  const bad={...readManifest(),extraAuthority:"admin"};
  assert.equal(validateAdapterManifest(bad).reason,"ADAPTER_SHAPE_INVALID");
  const enabledWrite={...readManifest(),capabilities:[{...readManifest().capabilities[0],sideEffect:"EXTERNAL_WRITE"}]};
  assert.equal(validateAdapterManifest(enabledWrite).reason,"WRITE_CAPABILITY_MUST_BE_DISABLED");
});

test("adapter operation decision intersects principal, agent and task scopes",()=>{
  const manifest=readManifest();
  const common={manifest,operationId:"repository.read",
    target:{resourceType:"repository",resourceId:"KRATT-PRIME"},
    principalScopes:["repository.read"],agentScopes:["repository.read"],taskScopes:["repository.read"],now};
  assert.equal(evaluateAdapterOperation(common).decision,"ALLOW");
  assert.equal(evaluateAdapterOperation({...common,agentScopes:[]}).reason,"EFFECTIVE_SCOPE_INSUFFICIENT");
  assert.equal(evaluateAdapterOperation({...common,target:{resourceType:"repository",resourceId:"OTHER"}}).reason,"TARGET_OUT_OF_SCOPE");
});

test("write capability is inert until exact verified approval binds provider, operation and target",()=>{
  const common={manifest:writeManifest(),operationId:"issue.comment",
    target:{resourceType:"issue",resourceId:"STE-105"},
    principalScopes:["issue.comment"],agentScopes:["issue.comment"],taskScopes:["issue.comment"],now};
  assert.equal(evaluateAdapterOperation(common).reason,"EXACT_VERIFIED_APPROVAL_REQUIRED");
  const approval={verificationState:"VERIFIED",approvalId:"approval-1",provider:"linear",
    operationId:"issue.comment",target:{resourceType:"issue",resourceId:"STE-105"},
    issuedAt:now,expiresAt:later,revoked:false};
  const result=evaluateAdapterOperation({...common,approval});
  assert.equal(result.decision,"ALLOW");
  assert.equal(result.executionStarted,false);
  assert.equal(evaluateAdapterOperation({...common,approval:{...approval,target:{resourceType:"issue",resourceId:"STE-999"}}}).decision,"BLOCKED");
});

test("evidence ledger is append-only, hash-chained, replay-safe and detects tampering",()=>{
  const ledger=new EvidenceLedger();
  const event={schemaVersion:"kratt-evidence/v1",eventId:"ev-1",eventType:"test.completed",
    actorId:"tester-1",occurredAt:now,subject:"task-5x",decision:"VERIFIED",
    sourceRef:{provider:"github",resource:"KRATT-PRIME",revision},
    artifactDigest:"sha256:"+"b".repeat(64),metadata:{workflow:"linux-operations",result:"success"}};
  assert.equal(ledger.append(event).ok,true);
  assert.equal(ledger.append(event).reason,"DUPLICATE_EVIDENCE_EVENT");
  assert.equal(ledger.verify().ok,true);
  const copied=ledger.list().entries;
  copied[0].event.metadata.result="forged";
  assert.equal(verifyEvidenceChain(copied).reason,"LEDGER_HASH_MISMATCH");
  assert.equal(ledger.append({...event,eventId:"ev-2",metadata:{token:"private"}}).reason,"SENSITIVE_EVIDENCE_REJECTED");
  assert.equal(ledger.verify().count,1);
});

test("template registry renders typed data and rejects unknown fields or code",()=>{
  const registry=new TemplateRegistry();
  assert.ok(BUILT_IN_TEMPLATE_IDS.length>=6);
  const rendered=registry.render("system-profile.v1",{
    platform:"linux",architecture:"x86_64",networkManagerState:"SINGLE_MANAGER_OBSERVED",
    interfaceCount:2,ipv4RouteCount:1,ipv6RouteCount:1,observedAt:now
  });
  assert.equal(rendered.ok,true);
  assert.equal(registry.render("system-profile.v1",{platform:"linux",architecture:"x86_64",networkManagerState:"x",
    interfaceCount:1,ipv4RouteCount:1,ipv6RouteCount:1,observedAt:now,exec:"process.exit()"}).reason,"TEMPLATE_UNKNOWN_VALUE");
  assert.equal(registry.render("network-change-proposal.v1",{}).reason.startsWith("TEMPLATE_REQUIRED_VALUE_MISSING:"),true);
});

test("workflow requires evidence at every stage and runs tester/auditor in parallel",()=>{
  const created=createWorkflowPlan({taskId:"task-5x",sourceRevision:revision,createdAt:now});
  assert.equal(created.ok,true);
  let workflow=created.workflow;
  const step=(role,action,evidenceRefs=[],approval=null)=>{
    const result=transitionWorkflowNode(workflow,{nodeId:"task-5x:"+role,actorRole:role,action,evidenceRefs,now,releaseApproval:approval});
    if(result.ok) workflow=result.workflow;
    return result;
  };
  assert.equal(step("architect","start").ok,true);
  assert.equal(step("architect","complete",["architecture-spec:1"]).ok,true);
  assert.equal(step("builder","start").ok,true);
  assert.equal(step("builder","complete",["source-revision:"+revision,"changed-files:1"]).ok,true);
  const summary=workflowSummary(workflow);
  assert.equal(summary.testerAuditorParallel,true);
  assert.equal(step("tester","start").ok,true);
  assert.equal(step("auditor","start").ok,true);
  assert.equal(step("tester","complete",["test-run:1"]).ok,true);
  assert.equal(step("auditor","complete",["audit-findings:1"]).ok,true);
  assert.equal(step("integrator","start").ok,true);
  assert.equal(step("integrator","complete",["integration-diff:1","rollback-target:"+revision]).ok,true);
  assert.equal(step("release","start").reason,"RELEASE_APPROVAL_REQUIRED");
  const approval={verificationState:"VERIFIED",approvalId:"release-approval-1",taskId:"task-5x",
    sourceRevision:revision,operation:"release-readiness",issuedAt:now,expiresAt:later,revoked:false};
  assert.equal(step("release","start",[],approval).ok,true);
  assert.equal(step("release","complete",["release-readiness:1","deployment-evidence:1"]).ok,true);
  assert.equal(workflow.state,"COMPLETED");
  assert.equal(workflow.executionStarted,true);
});

test("adaptive bootstrap detects OS and network state but never mutates configuration",()=>{
  const result=hostProfile();
  assert.equal(result.ok,true);
  assert.equal(result.profile.packageManager.preferred,"apt-get");
  assert.equal(result.profile.cpu.onlineCount,8);
  assert.equal(result.profile.network.managementState,"SINGLE_MANAGER_OBSERVED");
  assert.equal(result.profile.network.ipv6RouteCount,1);
  assert.equal(result.automaticChangesEnabled,false);
  const plan=createAdaptiveBootstrapPlan(result);
  assert.equal(plan.ok,true);
  assert.equal(plan.executionStarted,false);
  assert.equal(plan.policy.writeOperationsEnabled,false);
});

test("adaptive bootstrap blocks automatic assumptions when multiple network managers are active",()=>{
  const result=hostProfile(true);
  assert.equal(result.readiness,"PARTIAL_REVIEW_REQUIRED");
  assert.ok(result.reviewReasons.includes("MULTIPLE_NETWORK_MANAGERS_ACTIVE"));
  assert.equal(result.profile.network.managementState,"MULTIPLE_MANAGERS_REVIEW");
});

test("runtime planner joins the five planes and does not start execution",()=>{
  const result=createRuntimeAssessment({
    taskId:"task-5x",sourceRevision:revision,now,hostProfile:hostProfile(),
    hardwareSnapshot:hardwareSnapshot(),stage:"PREFILL",allowedBackends:["CPU","GPU"],
    adapterManifests:[readManifest()],trustedPolicyDecision:trustedPolicy(),
    requiredEvidence:["test-run","audit-findings"]
  });
  assert.equal(result.ok,true);
  assert.equal(result.plan.state,"PLAN_PROPOSED");
  assert.equal(result.plan.computeRoute.target,"GPU");
  assert.equal(result.plan.planes.policy,"ALLOW");
  assert.equal(result.plan.execution.executionStarted,false);
  assert.equal(result.plan.execution.providerWrites,false);
});

test("runtime planner is fail-closed without trusted policy or for denied policy",()=>{
  const base={taskId:"task-5x",sourceRevision:revision,now,hostProfile:hostProfile(),
    hardwareSnapshot:hardwareSnapshot(),allowedBackends:["CPU","GPU"],adapterManifests:[]};
  assert.equal(createRuntimeAssessment(base).plan.state,"BLOCKED");
  assert.ok(createRuntimeAssessment({...base,trustedPolicyDecision:trustedPolicy("DENY")})
    .plan.blockers.includes("POLICY_DENY"));
});

test("evidence metrics count observed states without inventing a confidence score",()=>{
  const metrics=aggregateEvidenceMetrics([
    {decision:"OBSERVED",eventType:"host.snapshot",artifactDigest:"sha256:a"},
    {decision:"VERIFIED",eventType:"test.run",artifactDigest:"sha256:b"},
    {decision:"BLOCKED",eventType:"adapter.write"}
  ]);
  assert.equal(metrics.ok,true);
  assert.equal(metrics.totalEvents,3);
  assert.equal(metrics.decisionCounts.VERIFIED,1);
  assert.equal(metrics.artifactDigestCoverage,2/3);
  assert.equal(Object.hasOwn(metrics,"confidence"),false);
});

test("Linux diagnostic allowlist includes read-only host inputs for adaptive profiling",()=>{
  const ids=LINUX_DIAGNOSTIC_COMMANDS.map(x=>x.id);
  for(const id of ["system.kernel","system.cpu_count","system.cpu.details","system.memory"])
    assert.ok(ids.includes(id));
  const report=collectLinuxDiagnostics({
    platform:"linux",commandAvailable:()=>true,
    runner:(executable,args)=>({status:0,stdout:args[0]==="--version"?"v1":"{}",stderr:"",error:null}),
    readFileSync:()=>"ID=debian",existsSync:()=>false,readdirSync:()=>[]
  });
  assert.equal(report.writesPerformed,false);
  assert.equal(report.privilegedOperationsPerformed,false);
  assert.equal(typeof report.collectedAt,"string");
});
