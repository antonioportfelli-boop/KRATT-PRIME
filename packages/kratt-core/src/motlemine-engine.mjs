import { createHash } from "node:crypto";
import { validateEvidenceRecord } from "./contracts.mjs";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const STANCES=new Set(["SUPPORTS","REFUTES"]);
const plain=v=>!!v&&typeof v==="object"&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{
 const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&"value"in d&&!d.get&&!d.set;
});
const digest=v=>createHash("sha256").update(v,"utf8").digest("hex");

/**
 * MÕTLEMINE v1 — deterministic evidence reflection and contradiction engine.
 *
 * SUPPORTS/REFUTES labels are assessor-supplied hypotheses, not facts.
 * Only evidence records independently accepted by verifyEvidence participate.
 * It emits an inspectable report and NEVER authorizes tasks, consumes approvals,
 * or changes KRATT policy decisions.
 */
export function createMotlemineEngine({verifyEvidence,minIndependentSources=2,maxClaims=64,maxEvidence=256}={}){
 if(typeof verifyEvidence!=="function")throw new TypeError("TRUSTED_EVIDENCE_VERIFIER_REQUIRED");
 if(!Number.isInteger(minIndependentSources)||minIndependentSources<1||minIndependentSources>8)throw new TypeError("SOURCE_THRESHOLD_INVALID");
 if(!Number.isInteger(maxClaims)||maxClaims<1||maxClaims>128||!Number.isInteger(maxEvidence)||maxEvidence<1||maxEvidence>512)
  throw new TypeError("REFLECTION_LIMIT_INVALID");

 function analyze({analysis_id,claims,evidence}={}){
  if(!ID.test(analysis_id??"")||!Array.isArray(claims)||claims.length<1||claims.length>maxClaims||
   !Array.isArray(evidence)||evidence.length>maxEvidence)return{status:"INPUT_INVALID",reason:"ANALYSIS_ENVELOPE_INVALID"};
  const evidenceById=new Map(),trustedEvidence=new Map();
  for(const raw of evidence){
   const checked=validateEvidenceRecord(raw);
   if(!checked.ok||evidenceById.has(checked.value.evidence_id))return{status:"INPUT_INVALID",reason:"EVIDENCE_INVALID_OR_DUPLICATE"};
   evidenceById.set(checked.value.evidence_id,checked.value);
   let verified=false;
   try{verified=checked.value.result==="VERIFIED"&&verifyEvidence(checked.value,Object.freeze({analysis_id}))===true;}catch{verified=false;}
   if(verified)trustedEvidence.set(checked.value.evidence_id,checked.value);
  }
  const claimById=new Map();
  for(const claim of claims){
   if(!exact(claim,["claim_id","statement","depends_on","assessments"])||!ID.test(claim.claim_id??"")||
    typeof claim.statement!=="string"||claim.statement.length<1||claim.statement.length>1000||
    !Array.isArray(claim.depends_on)||claim.depends_on.length>32||claim.depends_on.some(x=>!ID.test(x))||
    new Set(claim.depends_on).size!==claim.depends_on.length||
    !Array.isArray(claim.assessments)||claim.assessments.length>maxEvidence||claimById.has(claim.claim_id))
    return{status:"INPUT_INVALID",reason:"CLAIM_SHAPE_INVALID"};
   for(const assessment of claim.assessments){
    if(!exact(assessment,["evidence_id","stance","rationale_code"])||
     !ID.test(assessment.evidence_id??"")||!STANCES.has(assessment.stance)||!ID.test(assessment.rationale_code??""))
     return{status:"INPUT_INVALID",reason:"ASSESSMENT_SHAPE_INVALID"};
    if(!evidenceById.has(assessment.evidence_id))return{status:"INPUT_INVALID",reason:"ASSESSMENT_EVIDENCE_NOT_FOUND"};
   }
   claimById.set(claim.claim_id,claim);
  }
  for(const claim of claims)if(claim.depends_on.some(dep=>!claimById.has(dep)))
   return{status:"INPUT_INVALID",reason:"CLAIM_DEPENDENCY_NOT_FOUND"};

  const visited=new Set(),active=new Set(),cyclic=new Set();
  function findCycles(id){
   if(active.has(id)){cyclic.add(id);return;}
   if(visited.has(id))return;
   active.add(id);
   for(const dep of claimById.get(id).depends_on){
    if(active.has(dep)){cyclic.add(id);cyclic.add(dep);continue;}
    findCycles(dep);
    if(cyclic.has(dep))cyclic.add(id);
   }
   active.delete(id);visited.add(id);
  }
  for(const id of claimById.keys())findCycles(id);

  const reports=new Map();
  function assess(id){
   if(reports.has(id))return reports.get(id);
   const claim=claimById.get(id);
   if(cyclic.has(id)){
    const blocked=Object.freeze({claim_id:id,status:"BLOCKED",reason:"DEPENDENCY_CYCLE",
     support_evidence_ids:Object.freeze([]),refute_evidence_ids:Object.freeze([]),
     independent_support_sources:0,independent_refute_sources:0,
     rejected_or_unverified_evidence_ids:Object.freeze(claim.assessments.map(a=>a.evidence_id).sort()),
     dependency_claim_ids:Object.freeze([...claim.depends_on])});
    reports.set(id,blocked);return blocked;
   }
   const dependencies=claim.depends_on.map(dep=>assess(dep));
   const assessments=claim.assessments.filter(a=>trustedEvidence.has(a.evidence_id));
   const supportIds=assessments.filter(a=>a.stance==="SUPPORTS").map(a=>a.evidence_id);
   const refuteIds=assessments.filter(a=>a.stance==="REFUTES").map(a=>a.evidence_id);
   const sourceKey=e=>e.source.source_type+":"+e.source.source_id;
   const supportSources=new Set(supportIds.map(eid=>sourceKey(trustedEvidence.get(eid))));
   const refuteSources=new Set(refuteIds.map(eid=>sourceKey(trustedEvidence.get(eid))));
   const overlap=new Set([...supportSources].filter(source=>refuteSources.has(source)));
   let status,reason;
   if(dependencies.some(dep=>dep.status!=="SUPPORTED")){status="BLOCKED";reason="DEPENDENCY_NOT_SUPPORTED";}
   else if(supportSources.size>0&&refuteSources.size>0){
    status="CONFLICTED";reason=overlap.size?"SAME_SOURCE_ASSIGNED_BOTH_STANCES":"INDEPENDENT_CONTRADICTION";
   }else if(supportSources.size>=minIndependentSources){status="SUPPORTED";reason="INDEPENDENT_SUPPORT_THRESHOLD_MET";}
   else if(refuteSources.size>=minIndependentSources){status="REFUTED";reason="INDEPENDENT_REFUTATION_THRESHOLD_MET";}
   else{status="INSUFFICIENT_EVIDENCE";reason="INDEPENDENT_SOURCE_THRESHOLD_NOT_MET";}
   const report=Object.freeze({
    claim_id:id,status,reason,
    support_evidence_ids:Object.freeze([...new Set(supportIds)].sort()),
    refute_evidence_ids:Object.freeze([...new Set(refuteIds)].sort()),
    independent_support_sources:supportSources.size,
    independent_refute_sources:refuteSources.size,
    rejected_or_unverified_evidence_ids:Object.freeze(claim.assessments.filter(a=>!trustedEvidence.has(a.evidence_id)).map(a=>a.evidence_id).sort()),
    dependency_claim_ids:Object.freeze([...claim.depends_on]),
   });
   reports.set(id,report);return report;
  }
  for(const id of claimById.keys())assess(id);
  const rows=[...reports.values()];
  const counts=Object.fromEntries(["SUPPORTED","REFUTED","CONFLICTED","INSUFFICIENT_EVIDENCE","BLOCKED"].map(s=>[s,rows.filter(r=>r.status===s).length]));
  const status=counts.CONFLICTED||counts.REFUTED||counts.BLOCKED?"REVIEW_REQUIRED":
   counts.INSUFFICIENT_EVIDENCE?"EVIDENCE_INCOMPLETE":"READY_FOR_REVIEW";
  const report={
   schema_version:"motlemine/v1",analysis_id,status,policy_authority:false,
   note:"Reasoning assessment only. It does not grant authorization or replace KRATT policy, approvals, or evidence verification.",
   thresholds:{minimum_independent_sources:minIndependentSources},
   counts,verified_evidence_ids:Object.freeze([...trustedEvidence.keys()].sort()),
   claims:Object.freeze(rows),
  };
  return Object.freeze({...report,report_digest:"sha256:"+digest(JSON.stringify(report))});
 }
 return Object.freeze({analyze});
}
