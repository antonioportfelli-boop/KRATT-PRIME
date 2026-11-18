import test from "node:test";
import assert from "node:assert/strict";
import { createMotlemineEngine } from "../src/motlemine-engine.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";
const at="2026-11-18T16:00:00.000Z";
const ev=(id,source,result="VERIFIED")=>({schema_version:KRATT_SCHEMA_VERSION,evidence_id:id,subject:"subject-01",
 claim_type:"TESTS_PASSED",source:{source_type:"github",source_id:source,revision:null},observed_at:at,
 verification_method:"signed-attestation",result,artifact_digest:null,metadata:{}});
const claim=(id,assessments,depends_on=[])=>({claim_id:id,statement:"Build is reproducible",depends_on,assessments});
const a=(evidence_id,stance="SUPPORTS")=>({evidence_id,stance,rationale_code:"independent-check"});
const engine=createMotlemineEngine({verifyEvidence:e=>e.source.source_type==="github",minIndependentSources:2});
test("two distinct trusted sources support a claim without treating the report as authorization",()=>{
 const r=engine.analyze({analysis_id:"analysis-01",evidence:[ev("e1","run1"),ev("e2","run2")],
  claims:[claim("claim-01",[a("e1"),a("e2")])]});
 assert.equal(r.status,"READY_FOR_REVIEW");assert.equal(r.claims[0].status,"SUPPORTED");
 assert.equal(r.policy_authority,false);assert.match(r.report_digest,/^sha256:/);
});
test("duplicate evidence from one source does not count as independent corroboration",()=>{
 const r=engine.analyze({analysis_id:"analysis-02",evidence:[ev("e1","same-run"),ev("e2","same-run")],
  claims:[claim("claim-01",[a("e1"),a("e2")])]});
 assert.equal(r.claims[0].status,"INSUFFICIENT_EVIDENCE");
 assert.equal(r.claims[0].independent_support_sources,1);
});
test("contradictory independently verified sources force review",()=>{
 const r=engine.analyze({analysis_id:"analysis-03",evidence:[ev("e1","run1"),ev("e2","run2")],
  claims:[claim("claim-01",[a("e1","SUPPORTS"),a("e2","REFUTES")])]});
 assert.equal(r.status,"REVIEW_REQUIRED");assert.equal(r.claims[0].status,"CONFLICTED");
 assert.equal(r.claims[0].reason,"INDEPENDENT_CONTRADICTION");
});
test("unverified evidence is excluded from support",()=>{
 const r=engine.analyze({analysis_id:"analysis-04",evidence:[ev("e1","run1","UNAVAILABLE")],
  claims:[claim("claim-01",[a("e1")])]});
 assert.equal(r.claims[0].status,"INSUFFICIENT_EVIDENCE");
 assert.deepEqual(r.claims[0].rejected_or_unverified_evidence_ids,["e1"]);
});
test("dependency cycles are blocked without recursing forever",()=>{
 const r=engine.analyze({analysis_id:"analysis-05",evidence:[],
  claims:[claim("claim-a",[],["claim-b"]),claim("claim-b",[],["claim-a"])]});
 assert.equal(r.status,"REVIEW_REQUIRED");
 assert.equal(r.claims.every(c=>c.status==="BLOCKED"&&c.reason==="DEPENDENCY_CYCLE"),true);
});
test("unknown evidence references and duplicate evidence records fail input validation",()=>{
 const missing=engine.analyze({analysis_id:"analysis-06",evidence:[],claims:[claim("claim-01",[a("missing")])]});
 assert.equal(missing.reason,"ASSESSMENT_EVIDENCE_NOT_FOUND");
 const duplicate=engine.analyze({analysis_id:"analysis-07",evidence:[ev("e1","run1"),ev("e1","run2")],
  claims:[claim("claim-01",[])]});
 assert.equal(duplicate.reason,"EVIDENCE_INVALID_OR_DUPLICATE");
});
