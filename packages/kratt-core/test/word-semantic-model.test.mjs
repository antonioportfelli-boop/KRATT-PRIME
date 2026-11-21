import test from "node:test";
import assert from "node:assert/strict";
import {
  createWordSemanticRecord,
  evaluateWordSemantics,
  validateWordSemanticRecord
} from "../src/word-semantic-model.mjs";

const now = "2026-11-21T21:00:00.000Z";

function make() {
  const result = createWordSemanticRecord({
    recordId: "semantic-1",
    sourceRef: "source:directive-1",
    sourceDigest: "a".repeat(64),
    contextId: "ctx:engineering",
    createdAt: now,
    form: {
      token_id: "token-1",
      surface: "sõna",
      language: "et",
      normalization: "NFC",
      span: { start: 0, end: 4 }
    },
    senses: [{
      sense_id: "sense-meaning",
      definition: "Kontekstuaalne tähendus",
      language: "et",
      domain: "linguistics",
      concept_ref: "concept:sense",
      confidence: 0.93,
      evidence_refs: ["evidence-1"]
    }],
    principles: [{
      principle_id: "norm-1",
      statement: "Tähendust hinnatakse kontekstis",
      norm_type: "OPERATIONAL",
      jurisdiction: "KRATT",
      valid_from: null,
      valid_until: null,
      source_refs: ["evidence-1"]
    }],
    intents: [{
      intent_id: "intent-1",
      actor_ref: "actor:user",
      goal: "Eristada semantilisi kihte",
      audience_refs: ["actor:agent"],
      context_ref: "ctx:engineering",
      confidence: 0.95
    }],
    speechActs: [{
      act_id: "act-1",
      act_type: "DIRECTIVE",
      speaker_ref: "actor:user",
      addressee_refs: ["actor:agent"],
      propositional_content: "Erista kihid",
      felicity_conditions: { understood: true }
    }],
    effects: [{
      effect_id: "effect-1",
      effect_type: "TECHNICAL",
      target_refs: ["system:kratt"],
      direction: "POSITIVE",
      magnitude: null,
      measurement_refs: [],
      causal_status: "ASSERTED"
    }],
    powers: [{
      power_id: "power-1",
      power_type: "INSTITUTIONAL",
      holder_ref: "actor:owner",
      target_refs: ["system:kratt"],
      mechanism: "Policy control",
      scope: "Feature branches",
      evidence_refs: ["evidence-1"]
    }],
    authorities: [{
      authority_id: "auth-1",
      authority_type: "DELEGATED",
      issuer_ref: "actor:owner",
      subject_ref: "actor:agent",
      action_scope: "Propose code",
      resource_scope: "feature/*",
      jurisdiction: "KRATT",
      valid_from: now,
      valid_until: null,
      evidence_refs: ["evidence-1"],
      status: "VERIFIED"
    }]
  });
  assert.equal(result.ok, true, result.reason);
  return structuredClone(result.value);
}

test("same surface form can carry distinct typed senses", () => {
  const record = make();
  record.senses.push({
    sense_id: "sense-principle",
    definition: "Normatiivne toimimisreegel",
    language: "et",
    domain: "governance",
    concept_ref: "concept:norm",
    confidence: 0.89,
    evidence_refs: ["evidence-2"]
  });
  assert.equal(validateWordSemanticRecord(record).ok, true);
  const result = evaluateWordSemantics(record, { now });
  assert.equal(result.status, "SEMANTIC_REVIEW_REQUIRED");
  assert.equal(result.ambiguous_sense_ids.length, 2);
});

test("semantic interpretation never grants policy authority", () => {
  const result = evaluateWordSemantics(make(), {
    now,
    requiredLayers: ["SENSE", "AUTHORITY"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.authorization_granted, false);
  assert.equal(result.policy_authority, false);
});

test("asserted effect is not silently promoted to causal fact", () => {
  const result = evaluateWordSemantics(make(), {
    now,
    requiredLayers: ["EFFECT"]
  });
  assert.deepEqual(result.effects_without_causal_establishment, ["effect-1"]);
});

test("revoked authority is surfaced as a conflict", () => {
  const record = make();
  record.authorities[0].status = "REVOKED";
  const result = evaluateWordSemantics(record, { now });
  assert.equal(result.status, "AUTHORITY_CONFLICT");
});

test("missing normative layer requires review", () => {
  const record = make();
  record.principles = [];
  const result = evaluateWordSemantics(record, {
    now,
    requiredLayers: ["PRINCIPLE"]
  });
  assert.equal(result.status, "SEMANTIC_REVIEW_REQUIRED");
  assert.deepEqual(result.missing_layers, ["PRINCIPLE"]);
});

test("malformed token offsets are rejected", () => {
  const record = make();
  record.form.span.end = 0;
  assert.equal(validateWordSemanticRecord(record).reason, "WORD_FORM_INVALID");
});

test("invalid confidence is rejected", () => {
  const record = make();
  record.senses[0].confidence = 1.5;
  assert.equal(validateWordSemanticRecord(record).reason, "SENSE_FIELDS_INVALID");
});

test("intent, speech act, principle and effect remain separate objects", () => {
  const record = make();
  assert.equal(record.principles[0].principle_id, "norm-1");
  assert.equal(record.intents[0].intent_id, "intent-1");
  assert.equal(record.speech_acts[0].act_id, "act-1");
  assert.equal(record.effects[0].effect_id, "effect-1");
  assert.notEqual(record.speech_acts[0].act_type, record.principles[0].norm_type);
});
