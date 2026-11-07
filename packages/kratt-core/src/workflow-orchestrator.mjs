/**
 * KRATT PRIME — evidence-gated agent workflow state machine v1.
 * Plans roles and verifies transitions; it does not invoke agents or tools.
 */
const ROLES=Object.freeze(["architect","builder","tester","auditor","integrator","release"]);
const STATES=Object.freeze(["WAITING","READY","RUNNING","COMPLETED","BLOCKED","FAILED","CANCELLED"]);
const SHA=/^[0-9a-f]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&
  (Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const bad=reason=>Object.freeze({ok:false,reason});
const freeze=v=>{
  if(Array.isArray(v)) return Object.freeze(v.map(freeze));
  if(plain(v)) {
    const out=Object.create(null);
    for(const [k,x] of Object.entries(v)) out[k]=freeze(x);
    return Object.freeze(out);
  }
  return v;
};
const DEFAULT_NODES=[
  {role:"architect",dependsOn:[],requiredEvidence:["architecture-spec"],approvalRequired:false},
  {role:"builder",dependsOn:["architect"],requiredEvidence:["source-revision","changed-files"],approvalRequired:false},
  {role:"tester",dependsOn:["builder"],requiredEvidence:["test-run"],approvalRequired:false},
  {role:"auditor",dependsOn:["builder"],requiredEvidence:["audit-findings"],approvalRequired:false},
  {role:"integrator",dependsOn:["tester","auditor"],requiredEvidence:["integration-diff","rollback-target"],approvalRequired:false},
  {role:"release",dependsOn:["integrator"],requiredEvidence:["release-readiness","deployment-evidence"],approvalRequired:true}
];

export function createWorkflowPlan({taskId,sourceRevision,createdAt}={}) {
  if(typeof taskId!=="string"||!ID.test(taskId)||
     typeof sourceRevision!=="string"||!SHA.test(sourceRevision)||
     typeof createdAt!=="string"||!TIME.test(createdAt)||!Number.isFinite(Date.parse(createdAt)))
    return bad("WORKFLOW_INPUT_INVALID");
  const nodes=DEFAULT_NODES.map((item,index)=>({
    nodeId:taskId+":"+item.role,role:item.role,
    dependsOn:item.dependsOn.map(role=>taskId+":"+role),
    requiredEvidence:[...item.requiredEvidence],approvalRequired:item.approvalRequired,
    state:index===0?"READY":"WAITING",evidenceRefs:[],startedAt:null,completedAt:null
  }));
  return Object.freeze({ok:true,workflow:freeze({
    schemaVersion:"kratt-agent-workflow/v1",taskId,sourceRevision,createdAt,
    updatedAt:createdAt,state:"ACTIVE",executionStarted:false,nodes
  })});
}

function cascadeReady(nodes) {
  let changed=true;
  while(changed) {
    changed=false;
    for(let i=0;i<nodes.length;i++) {
      const node=nodes[i];
      if(node.state!=="WAITING") continue;
      const deps=node.dependsOn.map(id=>nodes.find(other=>other.nodeId===id));
      if(deps.length && deps.every(dep=>dep?.state==="COMPLETED")) {
        nodes[i]={...node,state:"READY"};
        changed=true;
      }
    }
  }
  return nodes;
}
function nextWorkflow(workflow,nodes,now) {
  const refreshed=cascadeReady(nodes);
  const state=refreshed.some(n=>n.state==="FAILED")?"FAILED":
    refreshed.every(n=>n.state==="COMPLETED")?"COMPLETED":
    refreshed.some(n=>n.state==="BLOCKED")?"BLOCKED":"ACTIVE";
  return freeze({...workflow,updatedAt:now,nodes:refreshed,state,
    executionStarted:refreshed.some(n=>n.state==="RUNNING"||n.state==="COMPLETED")});
}
function exactReleaseApproval(approval,workflow,now) {
  return plain(approval) && Object.keys(approval).every(k=>
    ["verificationState","approvalId","taskId","sourceRevision","operation","issuedAt","expiresAt","revoked"].includes(k)) &&
    approval.verificationState==="VERIFIED" && typeof approval.approvalId==="string" &&
    approval.taskId===workflow.taskId && approval.sourceRevision===workflow.sourceRevision &&
    approval.operation==="release-readiness" && approval.revoked===false &&
    typeof approval.issuedAt==="string" && TIME.test(approval.issuedAt) &&
    typeof approval.expiresAt==="string" && TIME.test(approval.expiresAt) &&
    Date.parse(approval.issuedAt)<=Date.parse(now) && Date.parse(approval.expiresAt)>Date.parse(now);
}

export function transitionWorkflowNode(workflow,input={}) {
  const {nodeId,actorRole,action,evidenceRefs=[],now,releaseApproval=null}=input;
  if(!workflow||workflow.schemaVersion!=="kratt-agent-workflow/v1"||
     !Array.isArray(workflow.nodes)||typeof now!=="string"||!TIME.test(now)||!Number.isFinite(Date.parse(now)))
    return bad("WORKFLOW_STATE_INVALID");
  const node=workflow.nodes.find(n=>n.nodeId===nodeId);
  if(!node) return bad("WORKFLOW_NODE_NOT_FOUND");
  if(!ROLES.includes(actorRole)||actorRole!==node.role) return bad("WORKFLOW_ROLE_MISMATCH");
  if(!["start","complete","block","fail","cancel"].includes(action)) return bad("WORKFLOW_ACTION_INVALID");
  if(action==="start") {
    if(node.state!=="READY") return bad("WORKFLOW_DEPENDENCIES_NOT_READY");
    if(node.approvalRequired&&!exactReleaseApproval(releaseApproval,workflow,now))
      return bad("RELEASE_APPROVAL_REQUIRED");
    const nodes=workflow.nodes.map(n=>n.nodeId===nodeId?{...n,state:"RUNNING",startedAt:now}: {...n});
    return Object.freeze({ok:true,workflow:nextWorkflow(workflow,nodes,now)});
  }
  if(node.state!=="RUNNING") return bad("WORKFLOW_NODE_NOT_RUNNING");
  if(action==="complete") {
    if(!Array.isArray(evidenceRefs)||evidenceRefs.length>64||
       evidenceRefs.some(x=>typeof x!=="string"||x.length>192)||
       node.requiredEvidence.some(required=>!evidenceRefs.some(ref=>ref===required||ref.startsWith(required+":"))))
      return bad("WORKFLOW_EVIDENCE_INCOMPLETE");
    const nodes=workflow.nodes.map(n=>n.nodeId===nodeId?{
      ...n,state:"COMPLETED",completedAt:now,evidenceRefs:[...new Set(evidenceRefs)]
    }:{...n});
    return Object.freeze({ok:true,workflow:nextWorkflow(workflow,nodes,now)});
  }
  const next=action==="block"?"BLOCKED":action==="fail"?"FAILED":"CANCELLED";
  const nodes=workflow.nodes.map(n=>n.nodeId===nodeId?{...n,state:next,completedAt:now}:{...n});
  return Object.freeze({ok:true,workflow:nextWorkflow(workflow,nodes,now)});
}

export function workflowSummary(workflow) {
  if(!workflow||!Array.isArray(workflow.nodes)) return bad("WORKFLOW_STATE_INVALID");
  const counts=Object.fromEntries(STATES.map(state=>[state,workflow.nodes.filter(n=>n.state===state).length]));
  const tester=workflow.nodes.find(n=>n.role==="tester");
  const auditor=workflow.nodes.find(n=>n.role==="auditor");
  return Object.freeze({
    ok:true,taskId:workflow.taskId,state:workflow.state,nodeCount:workflow.nodes.length,
    counts:Object.freeze(counts),
    testerAuditorParallel:Boolean(tester&&auditor&&
      tester.dependsOn.includes(workflow.taskId+":builder")&&
      auditor.dependsOn.includes(workflow.taskId+":builder")),
    releaseRequiresApproval:workflow.nodes.find(n=>n.role==="release")?.approvalRequired===true
  });
}
