import test from "node:test";
import assert from "node:assert/strict";
import { createMeridianTruthChain } from "../src/meridian-truth-chain.mjs";
import { createMotlemineEngine } from "../src/motlemine-engine.mjs";
import { createWordSemanticRecord } from "../src/word-semantic-model.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";

const at = "2026-11-22T10:00:00.000Z";

function makeRecord({ includeSense = true, sourceRefs = ["evidence-source"] } = {}) {
  const result = createWordSemanticRecord({
    recordId: "meridian-record-01",
    sourceRef: "github:meridian-source",
    sourceDigest: "a".repeat(64),
    sourceEvidenceId: "evidence-source",
    contextId: "ctx:meridian",
    createdAt: at,
    form: { token_id: "token-meridian", surface: "sõna", language: "et", normalization: "NFC", span: { start: 0, end: 4 } },
    contents: [{
      content_id: "content-meridian", content_type: "PROPOSITION", payload: "Allikapõhine väide.",
      language: "et", domain: "semantics", referent_refs: [], evidence_refs: sourceRefs,
      attribution: { kind: "SOURCE", actor_ref: "actor:source" }, confidence: 0.98
    }],
    senses: includeSense ? [{
      sense_id: "sense-meridian", content_refs: ["content-meridian"], definition: "Kontekstuaalne tõlgendus",
      language: "et", domain: "semantics", concept_ref: null, confidence: 0.9,
      evidence_refs: ["evidence-source"]
    }] : [],
    principles: [], intents: [], speechActs: [], effects: [], powers: [], authorities: []
  });
  assert.equal(result.ok, true, result.reason);
  return structuredClone(result.value);
}

function evidence(id, sourceId) {
  return {
    schema_version: KRATT_SCHEMA_VERSION,
    evidence_id: id,
    subject: record.record_id,
    claim_type: "TESTS_PASSED",
    source: { source_type: "github", source_id: sourceId, revision: null },
    observed_at: at,
    verification_method: "signed-attestation",
    result: "VERIFIED",
    artifact_digest: null,
    metadata: {}
  };
}

function reflection(record, { conflict = false } = {}) {
  const items = [evidence("evidence-1", "independent-source-1"), evidence("evidence-2", "independent-source-2")];
  return {
    analysis_id: conflict ? "meridian-conflict-01" : "meridian-support-01",
    record_id: record.record_id,
    source_digest: record.source.source_digest,
    claim_bindings: [{ claim_id: "claim-meridian", target_type: "CONTENT", target_id: record.contents[0].content_id }],
    evidence: items,
    claims: [{
      claim_id: "claim-meridian",
      statement: record.contents[0].payload,
      depends_on: [],
      assessments: [
        { evidence_id: "evidence-1", stance: "SUPPORTS", rationale_code: "independent-attestation" },
        { evidence_id: "evidence-2", stance: conflict ? "REFUTES" : "SUPPORTS", rationale_code: "independent-attestation" }
      ]
    }]
  };
}

test("Talmud preflight anchors the extracted CONTENT to source evidence", () => {
  const chain = createMeridianTruthChain();
  const result = chain.talmudPreflight({ record: makeRecord() });
  assert.equal(result.ok, true);
  assert.equal(result.status, "PRECHECK_PASSED");
  assert.equal(result.report.policy_authority, false);
});

test("preflight blocks content detached from its source evidence and proposes re-extraction", () => {
  const chain = createMeridianTruthChain();
  const result = chain.talmudPreflight({ record: makeRecord({ sourceRefs: ["different-evidence"] }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SOURCE_CONTENT_NOT_BOUND_TO_SOURCE_EVIDENCE");
  assert.equal(result.correction_proposals[0].action, "RE_EXTRACT_CONTENT_FROM_ORIGINAL_SOURCE");
  assert.equal(result.correction_proposals[0].auto_apply, false);
});

test("Anti-Talmud postflight requires the semantic interpretation layer", () => {
  const chain = createMeridianTruthChain({ clock: () => at });
  const preflight = chain.talmudPreflight({ record: makeRecord({ includeSense: false }) });
  assert.equal(preflight.ok, true);
  const postflight = chain.antiTalmudPostflight({ record: makeRecord({ includeSense: false }), preflightToken: preflight.token });
  assert.equal(postflight.ok, false);
  assert.equal(postflight.status, "REVIEW_REQUIRED");
  assert.ok(postflight.correction_proposals.some(p => p.code === "REQUIRED_SEMANTIC_LAYER_MISSING" && p.details.layer === "SENSE"));
  assert.equal(postflight.report.auto_corrections_applied, 0);
});

test("postflight blocks a changed source occurrence and never silently repairs it", () => {
  const chain = createMeridianTruthChain({ clock: () => at });
  const record = makeRecord();
  const preflight = chain.talmudPreflight({ record });
  record.contents[0].payload = "Muudetud pärast lähtekontrolli.";
  const postflight = chain.antiTalmudPostflight({ record, preflightToken: preflight.token });
  assert.equal(postflight.ok, false);
  assert.equal(postflight.reason, "SOURCE_ORIGIN_MUTATED_AFTER_PREFLIGHT");
  assert.equal(postflight.correction_proposals[0].auto_apply, false);
});

test("MÕTLEMINE reflection clears two independent supports but not contradiction", () => {
  const engine = createMotlemineEngine({ verifyEvidence: e => e.source.source_type === "github", minIndependentSources: 2 });
  const chain = createMeridianTruthChain({ reflectionEngine: engine, requireReflection: true, clock: () => at });
  const source = makeRecord();
  const clear = reflection(source);
  const preflight = chain.talmudPreflight({ record: source, reflection: clear });
  assert.equal(preflight.ok, true);
  const postflight = chain.antiTalmudPostflight({ record: source, preflightToken: preflight.token, reflection: clear });
  assert.equal(postflight.ok, true);
  assert.equal(postflight.status, "CLEAR_FOR_POLICY_GATE");
  assert.equal(postflight.report.reflection_status, "READY_FOR_REVIEW");

  const conflictChain = createMeridianTruthChain({ reflectionEngine: engine, requireReflection: true, clock: () => at });
  const conflicted = conflictChain.talmudPreflight({ record: source, reflection: reflection(source, { conflict: true }) });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.status, "NEEDS_REVIEW");
  assert.ok(conflicted.correction_proposals.some(p => p.code === "INDEPENDENT_EVIDENCE_CONFLICT"));
});

test("postflight emits an advisory instead of claiming an asserted effect is causal proof", () => {
  const chain = createMeridianTruthChain({ clock: () => at });
  const record = makeRecord();
  record.effects.push({
    effect_id: "effect-meridian", effect_type: "TECHNICAL", target_refs: ["system:kratt"],
    direction: "POSITIVE", magnitude: null, evidence_refs: ["evidence-source"],
    measurement_refs: [], causal_status: "ASSERTED"
  });
  const preflight = chain.talmudPreflight({ record });
  const postflight = chain.antiTalmudPostflight({ record, preflightToken: preflight.token });
  assert.equal(postflight.ok, true);
  assert.ok(postflight.correction_proposals.some(p => p.code === "EFFECT_CAUSALITY_NOT_ESTABLISHED" && p.severity === "ADVISORY"));
  assert.equal(postflight.report.authorization_granted, false);
});
