import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSemanticPreservation, evaluateTalmudPreflight, evaluateAntiTalmudPostflight,
  createCorrectionProposal, evaluateEchoRestoration, evaluatePolymorphosisRoundTrip,
  evaluateSemanticMemoryDependencies, appendMeridianNode, verifyMeridianChain,
  createSipa11GuardedDispatchRuntime,
} from "../src/semantic-integrity.mjs";

const source = () => ({
  modality: "MUST", subject: "repository:KRATT-PRIME", scope: "branch:feature",
  conditions: ["approval:request-bound"], effect: "read-only", authority: "repository.read",
  power: "read", freshness: "max-age:5m", provenance: "source:policy-v1",
  principle: "preserve-source", wordMeaning: "distinct", prohibitedEquivalences: ["approval!=authorization"],
});
const candidate = () => structuredClone(source());
const preflight = () => ({
  source: source(), proposed: candidate(), provenanceVerified: true, evidenceVerified: true,
  authorityScoped: true, conflictFree: true, sourceVersionKnown: true, freshnessVerified: true,
});

test("semantic comparison blocks modality weakening and dropped conditions", () => {
  const next = candidate(); next.modality = "SHOULD"; next.conditions = [];
  const result = evaluateSemanticPreservation(source(), next);
  assert.equal(result.ok, false);
  assert.ok(result.findings.includes("MODALITY_WEAKENED"));
  assert.ok(result.findings.includes("CONDITION_DROPPED"));
});

test("semantic comparison catches polarity changes and non-obvious word dimensions", () => {
  const next = candidate(); next.modality = "MUST_NOT"; next.wordMeaning = "authority";
  const result = evaluateSemanticPreservation(source(), next);
  assert.ok(result.findings.includes("MODALITY_POLARITY_CHANGED"));
  assert.ok(result.findings.includes("WORDMEANING_CHANGED"));
});

test("semantic comparison rejects unknown keys, accessor fields and sparse conditions", () => {
  const unknown = candidate(); unknown.semanticShortcut = true;
  assert.equal(evaluateSemanticPreservation(source(), unknown).ok, false);
  const accessor = candidate();
  Object.defineProperty(accessor, "authority", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.equal(evaluateSemanticPreservation(source(), accessor).ok, false);
  const sparse = candidate(); sparse.conditions = new Array(1);
  assert.equal(evaluateSemanticPreservation(source(), sparse).ok, false);
});

test("Talmud preflight passes only when all source, evidence, authority and conflict gates pass", () => {
  assert.equal(evaluateTalmudPreflight(preflight()).decision, "PASS");
  assert.equal(evaluateTalmudPreflight({ ...preflight(), sourceVersionKnown: false }).decision, "BLOCKED");
  assert.equal(evaluateTalmudPreflight({ ...preflight(), authorityScoped: false }).decision, "BLOCKED");
});

test("Anti-Talmud requires independent evidence and detects actual divergence", () => {
  assert.equal(evaluateAntiTalmudPostflight({ expected: source(), observed: candidate() }).decision, "QUARANTINE");
  const observed = candidate(); observed.effect = "external-write";
  assert.equal(evaluateAntiTalmudPostflight({ expected: source(), observed, independentEvidenceVerified: true }).decision, "FINDING");
});

test("Correction Forge freezes a proposal but never grants application rights", () => {
  const proposal = createCorrectionProposal({
    proposalId: "correction-1", findingId: "finding-1", affectedObjectIds: ["echo-1"],
    sourceReferences: ["github:commit:abc"], restoredInvariants: ["authority", "scope"],
    dependencyObjectIds: ["memory-1"], testReferences: ["test:semantic-1"], sourceVerified: true,
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.proposal.applicationAllowed, false);
  assert.equal(proposal.proposal.status, "PROPOSED");
  assert.equal(Object.isFrozen(proposal.proposal), true);
  assert.equal(Object.isFrozen(proposal.proposal.restoredInvariants), true);
  assert.equal(createCorrectionProposal({ ...proposal.proposal, sourceVerified: false }).ok, false);
});

test("Echo restoration requires Meridian, approval, constitution, invariant and round-trip gates", () => {
  const ready = { meridianRestored: true, meridianVerified: true, approvalVerified: true, invariantsVerified: true, constitutionVersionMatches: true, roundTripVerified: true };
  assert.equal(evaluateEchoRestoration({ ...ready, meridianRestored: false }).decision, "QUARANTINE");
  assert.equal(evaluateEchoRestoration({ ...ready, approvalVerified: false }).decision, "BLOCKED");
  assert.equal(evaluateEchoRestoration(ready).decision, "RELEASE_ELIGIBLE");
});

test("Polymorphosis round-trip catches unpreserved fields and blocks privilege loss", () => {
  assert.equal(evaluatePolymorphosisRoundTrip({ canonical: source(), forward: candidate(), restored: candidate() }).decision, "ROUND_TRIP_PRESERVED");
  const next = candidate(); next.scope = "all-resources";
  assert.equal(evaluatePolymorphosisRoundTrip({ canonical: source(), forward: next, restored: candidate() }).ok, false);
  const privileged = evaluatePolymorphosisRoundTrip({ canonical: source(), forward: candidate(), restored: candidate(), declaredLosses: ["authority"] });
  assert.equal(privileged.decision, "BLOCKED");
});

test("semantic memory becomes stale when provenance evidence is invalidated", () => {
  const memory = { id: "memory-1", evidenceIds: ["evidence-a", "evidence-b"], provenanceVerified: true };
  assert.equal(evaluateSemanticMemoryDependencies(memory, ["evidence-b"]).decision, "STALE");
  assert.equal(evaluateSemanticMemoryDependencies({ ...memory, provenanceVerified: false }, []).decision, "QUARANTINE");
});

test("Meridian chain is tamper-evident, ordered and rejects duplicate node IDs", () => {
  const node = { id: "source-1", kind: "SOURCE", sourceRef: "github:repo:KRATT-PRIME", version: "v1", createdAt: "2026-11-22T12:00:00Z" };
  const appended = appendMeridianNode([], node);
  assert.equal(appended.ok, true);
  const chain = [appended.entry];
  assert.equal(verifyMeridianChain(chain).ok, true);
  assert.equal(appendMeridianNode(chain, node).ok, false);
  const tampered = structuredClone(chain); tampered[0].node.version = "v2";
  assert.equal(verifyMeridianChain(tampered).ok, false);
});

test("guarded dispatch stops before effects when Talmud preflight blocks", async () => {
  let dispatched = false;
  const runtime = createSipa11GuardedDispatchRuntime({
    dispatchRuntime: { execute: async () => { dispatched = true; return { status: "COMPLETED" }; } },
    loadSemanticContext: async () => ({ ...preflight(), provenanceVerified: false, sourceReference: "github:repo", sourceVersion: "v1" }),
    loadIndependentPostflight: async () => null,
    meridianStore: { append: async () => true, verify: async () => ({ ok: true }) },
    now: () => Date.parse("2026-11-22T12:00:00Z"),
  });
  const result = await runtime.execute({ task: { task_id: "task-1" } });
  assert.equal(result.dispatched, false);
  assert.equal(dispatched, false);
});

test("guarded dispatch invokes the existing dispatcher and appends independently verified postflight", async () => {
  const chain = [];
  const store = {
    append: async node => { const next = appendMeridianNode(chain, node); if (!next.ok) return false; chain.push(next.entry); return true; },
    verify: async () => verifyMeridianChain(chain),
  };
  let dispatched = false;
  const runtime = createSipa11GuardedDispatchRuntime({
    dispatchRuntime: { execute: async () => { dispatched = true; return { status: "COMPLETED", provider_reference: "mock" }; } },
    loadSemanticContext: async () => ({ ...preflight(), sourceReference: "github:repo", sourceVersion: "v1" }),
    loadIndependentPostflight: async () => ({ observed: candidate(), independentEvidenceVerified: true, sourceRef: "github:postflight" }),
    meridianStore: store,
    now: () => Date.parse("2026-11-22T12:00:00Z"),
  });
  const result = await runtime.execute({ task: { task_id: "task-2" } });
  assert.equal(dispatched, true);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.semanticPostflight.decision, "PASS");
  assert.equal(verifyMeridianChain(chain).count, 2);
});

test("postflight divergence quarantines an already dispatched action and persists proposal only", async () => {
  const chain = [], proposals = [];
  const store = {
    append: async node => { const next = appendMeridianNode(chain, node); if (!next.ok) return false; chain.push(next.entry); return true; },
    verify: async () => verifyMeridianChain(chain),
  };
  const observed = candidate(); observed.effect = "external-write";
  const runtime = createSipa11GuardedDispatchRuntime({
    dispatchRuntime: { execute: async () => ({ status: "COMPLETED" }) },
    loadSemanticContext: async () => ({ ...preflight(), sourceReference: "github:repo", sourceVersion: "v1" }),
    loadIndependentPostflight: async () => ({ observed, independentEvidenceVerified: true, sourceVerified: true }),
    meridianStore: store,
    correctionStore: { propose: async proposal => { proposals.push(proposal); return true; } },
    now: () => Date.parse("2026-11-22T12:00:00Z"),
  });
  const result = await runtime.execute({ task: { task_id: "task-3" } });
  assert.equal(result.status, "QUARANTINED");
  assert.equal(result.dispatched, true);
  assert.equal(result.correctionPersisted, true);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].applicationAllowed, false);
});
