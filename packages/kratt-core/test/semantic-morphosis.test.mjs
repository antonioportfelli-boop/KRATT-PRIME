import test from "node:test";
import assert from "node:assert/strict";
import {
  appendMorphosisAuditEvent,
  createSemanticIdentity,
  canonicalize,
  digest,
  evaluateAntiSemanticChallenge,
  executePolymorphosis,
  runSemanticMorphosisPipeline,
} from "../src/semantic-morphosis.mjs";

const identity = () => ({
  id: "term:authorization",
  version: "1.0.0",
  context: { domain: "security", language: "en" },
  wordContent: { lexical: "authorization" },
  meaning: { definition: "verified permission for a specific action" },
  principle: { rule: "approval is not authorization" },
  effect: { expected: "read-only" },
  authority: { issuer: "policy-engine", scope: ["repository.read"] },
  modality: "MUST",
  subject: "repository:KRATT-PRIME",
  scope: "branch:feature",
  conditions: ["request-bound-approval"],
  freshness: "max-age:5m",
  provenance: "policy-v1",
});
const profile = () => ({
  id: "canonical-json",
  version: "1.0.0",
  targetForm: "adapter-contract",
  roundTrip: "REQUIRED",
  invariants: [
    { id: "identity", sourcePath: "id", targetPath: "id" },
    { id: "word", sourcePath: "wordContent", targetPath: "wordContent" },
    { id: "meaning", sourcePath: "meaning", targetPath: "meaning" },
    { id: "principle", sourcePath: "principle", targetPath: "principle" },
    { id: "effect", sourcePath: "effect", targetPath: "effect" },
    { id: "authority", sourcePath: "authority", targetPath: "authority" },
    { id: "version", sourcePath: "version", targetPath: "version" },
    { id: "context", sourcePath: "context", targetPath: "context" },
    { id: "modality", sourcePath: "modality", targetPath: "modality" },
    { id: "subject", sourcePath: "subject", targetPath: "subject" },
    { id: "scope", sourcePath: "scope", targetPath: "scope" },
    { id: "conditions", sourcePath: "conditions", targetPath: "conditions" },
    { id: "freshness", sourcePath: "freshness", targetPath: "freshness" },
    { id: "provenance", sourcePath: "provenance", targetPath: "provenance" },
  ],
  losses: [],
});
const identityTransform = value => structuredClone(value);

test("canonical identity preserves five independent semantic dimensions", () => {
  const result = createSemanticIdentity(identity());
  assert.deepEqual(Object.keys(result).filter(key => ["wordContent", "meaning", "principle", "effect", "authority"].includes(key)).sort(),
    ["authority", "effect", "meaning", "principle", "wordContent"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.authority), true);
});

test("identity rejects missing dimension and accessor properties", () => {
  const missing = identity(); delete missing.authority;
  assert.throws(() => createSemanticIdentity(missing), /SMF_DIMENSION_REQUIRED/);
  const hostile = identity(); Object.defineProperty(hostile, "meaning", { enumerable: true, get() { throw new Error("getter-executed"); } });
  assert.throws(() => createSemanticIdentity(hostile), /SMF_ACCESSOR_OR_HIDDEN_PROPERTY/);
});

test("canonicalization and digest are key-order independent", () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test("anti-semantic challenge finds a changed principle and authority", () => {
  const source = identity();
  const candidate = identity(); candidate.id = "candidate-1"; candidate.principle = { rule: "approval grants authority" }; candidate.authority = { scope: ["repository.write"] };
  const result = evaluateAntiSemanticChallenge({ source, candidates: [candidate] });
  assert.equal(result.decision, "COUNTEREXAMPLE_FOUND");
  assert.ok(result.candidates[0].findings.includes("DIMENSION_CHANGED:principle"));
  assert.ok(result.candidates[0].findings.includes("DIMENSION_CHANGED:authority"));
});

test("no counterexample is explicitly not proof of truth", () => {
  const result = evaluateAntiSemanticChallenge({ source: identity(), candidates: [identity()] });
  assert.equal(result.decision, "NO_COUNTEREXAMPLE_FOUND");
  assert.match(result.note, /not proof of truth/i);
});

test("challenge without candidate coverage is inconclusive", () => {
  assert.equal(evaluateAntiSemanticChallenge({ source: identity(), candidates: [] }).decision, "INCONCLUSIVE");
});

test("polymorphosis passes a lossless required round-trip", () => {
  const result = executePolymorphosis({ source: identity(), profile: profile(), toTarget: identityTransform, toCanonical: identityTransform });
  assert.equal(result.ok, true);
  assert.equal(result.decision, "TRANSFORMED");
  assert.equal(result.authorityGranted, false);
  assert.equal(result.sourceDigest, result.targetDigest);
});

test("polymorphosis blocks protected dimension drift", () => {
  const result = executePolymorphosis({
    source: identity(), profile: profile(),
    toTarget: source => ({ ...structuredClone(source), authority: { scope: ["repository.write"] } }),
    toCanonical: identityTransform,
  });
  assert.equal(result.ok, false);
  assert.ok(result.invariantFindings.includes("INVARIANT_MISMATCH:authority"));
});

test("polymorphosis rejects a lossy authority mapping", () => {
  const p = profile(); p.losses = [{ sourcePath: "authority", reason: "not needed" }];
  assert.equal(executePolymorphosis({ source: identity(), profile: p, toTarget: identityTransform, toCanonical: identityTransform }).ok, false);
});

test("polymorphosis rejects silent source-field loss", () => {
  const p = profile(); p.invariants = p.invariants.filter(item => item.sourcePath !== "context");
  assert.match(executePolymorphosis({ source: identity(), profile: p, toTarget: identityTransform, toCanonical: identityTransform }).reason, /SMF_UNDECLARED_FIELD_LOSS/);
});

test("pipeline fails closed when Talmud preflight fails", () => {
  const result = runSemanticMorphosisPipeline({ preflight: { provenanceVerified: false } });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.stage, "TALMUD_PREFLIGHT");
});

test("pipeline quarantines output without independent postflight evidence", () => {
  const source = identity();
  const result = runSemanticMorphosisPipeline({
    source,
    preflight: { source, proposed: source, provenanceVerified: true, evidenceVerified: true, authorityScoped: true, conflictFree: true },
    counterInterpretations: [source], profile: profile(), toTarget: identityTransform, toCanonical: identityTransform,
  });
  assert.equal(result.decision, "QUARANTINE");
  assert.equal(result.stage, "ANTI_TALMUD_POSTFLIGHT");
});

test("pipeline passes only after independent postflight agrees", () => {
  const source = identity();
  const result = runSemanticMorphosisPipeline({
    source,
    preflight: { source, proposed: source, provenanceVerified: true, evidenceVerified: true, authorityScoped: true, conflictFree: true },
    counterInterpretations: [source], profile: profile(), toTarget: identityTransform, toCanonical: identityTransform,
    observedCanonical: source, independentEvidenceVerified: true,
  });
  assert.equal(result.decision, "PASS");
  assert.equal(result.authorityGranted, false);
});

test("pipeline creates only a correction proposal after observed divergence", () => {
  const source = identity(); const observed = identity(); observed.effect = { expected: "external-write" };
  const result = runSemanticMorphosisPipeline({
    source,
    preflight: { source, proposed: source, provenanceVerified: true, evidenceVerified: true, authorityScoped: true, conflictFree: true },
    counterInterpretations: [source], profile: profile(), toTarget: identityTransform, toCanonical: identityTransform,
    observedCanonical: observed, independentEvidenceVerified: true,
    proposalId: "fix-1", findingId: "finding-1", affectedObjectIds: ["term:authorization"],
    restoredInvariants: ["effect"], sourceVerified: true, meridianRestored: false,
    approvalVerified: false, invariantsVerified: false,
  });
  assert.equal(result.decision, "FINDING");
  assert.equal(result.correction.ok, true);
  assert.equal(result.correction.proposal.status, "PROPOSED");
  assert.equal(result.echo.decision, "QUARANTINE");
});

test("Meridian audit appends a provenance-linked morphosis node", () => {
  const result = appendMorphosisAuditEvent([], {
    id: "smf-audit-1", sourceRef: "registry:term:authorization", profileId: "canonical-json",
    profileVersion: "1.0.0", actor: "kratt-core", createdAt: "2026-11-22T12:00:00Z", decision: "TRANSFORMED",
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.node.kind, "SMF_POLYMORPHOSIS");
});


test("postflight catches semantic meaning, principle, and lexical-content drift", () => {
  for (const dimension of ["wordContent", "meaning", "principle"]) {
    const source = identity();
    const observed = identity();
    observed[dimension] = { ...observed[dimension], postflightMutation: true };
    const result = runSemanticMorphosisPipeline({
      source,
      preflight: { source, proposed: source, provenanceVerified: true, evidenceVerified: true, authorityScoped: true, conflictFree: true },
      counterInterpretations: [source], profile: profile(), toTarget: identityTransform, toCanonical: identityTransform,
      observedCanonical: observed, independentEvidenceVerified: true,
      proposalId: "fix-" + dimension, findingId: "finding-" + dimension,
      affectedObjectIds: [source.id], restoredInvariants: [dimension], sourceVerified: true,
      meridianRestored: false, approvalVerified: false, invariantsVerified: false,
    });
    assert.equal(result.decision, "FINDING", dimension);
    assert.ok(result.postflight.findings.includes("SMF_POSTFLIGHT_DIMENSION_CHANGED:" + dimension));
  }
});

test("context is protected from lossy polymorphosis", () => {
  const p = profile();
  p.invariants = p.invariants.filter(item => item.sourcePath !== "context");
  p.losses = [{ sourcePath: "context", reason: "not needed" }];
  const result = executePolymorphosis({
    source: identity(), profile: p, toTarget: identityTransform, toCanonical: identityTransform,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /SMF_PROTECTED_LOSS_FORBIDDEN:context/);
});

test("loss declarations must refer to existing unique source paths", () => {
  const missing = profile();
  missing.losses = [{ sourcePath: "notPresent", reason: "legacy field" }];
  assert.match(executePolymorphosis({
    source: identity(), profile: missing, toTarget: identityTransform, toCanonical: identityTransform,
  }).reason, /SMF_LOSS_SOURCE_PATH_MISSING/);

  const duplicate = profile();
  duplicate.losses = [
    { sourcePath: "legacyNote", reason: "not mapped 1" },
    { sourcePath: "legacyNote", reason: "not mapped 2" },
  ];
  const source = { ...identity(), legacyNote: "archive" };
  assert.match(executePolymorphosis({
    source, profile: duplicate, toTarget: value => {
      const target = structuredClone(value); delete target.legacyNote; return target;
    }, toCanonical: value => {
      const canonical = structuredClone(value); canonical.legacyNote = "archive"; return canonical;
    },
  }).reason, /SMF_LOSS_DUPLICATE/);
});
