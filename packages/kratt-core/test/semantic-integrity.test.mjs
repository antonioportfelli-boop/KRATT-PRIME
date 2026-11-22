import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSemanticPreservation, evaluateTalmudPreflight, evaluateAntiTalmudPostflight, createCorrectionProposal, evaluateEchoRestoration, appendMeridianNode, verifyMeridianChain } from "../src/semantic-integrity.mjs";

const source = () => ({ modality: "MUST", subject: "repository:KRATT-PRIME", scope: "branch:feature", conditions: ["approval:request-bound"], effect: "read-only", authority: "repository.read", freshness: "max-age:5m", provenance: "source:policy-v1", prohibitedEquivalences: ["approval!=authorization"] });
const validCandidate = () => structuredClone(source());

test("semantic comparison detects modality weakening and dropped conditions", () => {
  const candidate = validCandidate(); candidate.modality = "SHOULD"; candidate.conditions = [];
  const result = evaluateSemanticPreservation(source(), candidate);
  assert.equal(result.ok, false); assert.ok(result.findings.includes("MODALITY_WEAKENED")); assert.ok(result.findings.includes("CONDITION_DROPPED"));
});

test("semantic comparison rejects authority, scope, and provenance changes", () => {
  const candidate = validCandidate(); candidate.authority = "repository.write"; candidate.scope = "all"; candidate.provenance = "unknown";
  const result = evaluateSemanticPreservation(source(), candidate);
  assert.deepEqual(result.findings, ["SCOPE_CHANGED_OR_MISSING", "AUTHORITY_CHANGED_OR_MISSING", "PROVENANCE_CHANGED_OR_MISSING"]);
});

test("Talmud preflight fails closed unless every trust gate passes", () => {
  const input = { source: source(), proposed: validCandidate(), provenanceVerified: true, evidenceVerified: true, authorityScoped: true, conflictFree: true };
  assert.equal(evaluateTalmudPreflight(input).decision, "PASS");
  assert.equal(evaluateTalmudPreflight({ ...input, authorityScoped: false }).decision, "BLOCKED");
});

test("Anti-Talmud requires independent postflight evidence", () => {
  assert.equal(evaluateAntiTalmudPostflight({ expected: source(), observed: validCandidate() }).decision, "QUARANTINE");
  const observed = validCandidate(); observed.effect = "external-write";
  assert.equal(evaluateAntiTalmudPostflight({ expected: source(), observed, independentEvidenceVerified: true }).decision, "FINDING");
});

test("Correction Forge emits proposal only with verified source and explicit invariants", () => {
  const input = { proposalId: "corr-1", findingId: "finding-1", affectedObjectIds: ["echo-1"], restoredInvariants: ["authority"], sourceVerified: true };
  assert.equal(createCorrectionProposal(input).ok, true);
  assert.equal(createCorrectionProposal({ ...input, sourceVerified: false }).ok, false);
});

test("Echo restoration is quarantined until Meridian, approval, and invariants pass", () => {
  assert.equal(evaluateEchoRestoration({ meridianRestored: false, approvalVerified: true, invariantsVerified: true }).decision, "QUARANTINE");
  assert.equal(evaluateEchoRestoration({ meridianRestored: true, approvalVerified: true, invariantsVerified: true }).decision, "RELEASE_ELIGIBLE");
});

test("Meridian chain detects tampering and rejects duplicate node IDs", () => {
  const node = { id: "source-1", kind: "SOURCE", sourceRef: "repo:main", version: "v1", createdAt: "2026-11-22T12:00:00Z" };
  const first = appendMeridianNode([], node); assert.equal(first.ok, true);
  const chain = [first.entry]; assert.equal(verifyMeridianChain(chain).ok, true);
  assert.equal(appendMeridianNode(chain, node).reason, "MERIDIAN_DUPLICATE_NODE");
  chain[0] = { ...chain[0], node: { ...chain[0].node, version: "v2" } }; assert.equal(verifyMeridianChain(chain).ok, false);
});