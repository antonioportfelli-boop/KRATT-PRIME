import test from "node:test";
import assert from "node:assert/strict";
import {
  AMBIGUITY_CONFIDENCE_THRESHOLD,
  SEMANTIC_LAYERS,
  WORD_SEMANTIC_SCHEMA,
  createWordSemanticRecord,
  evaluateWordSemantics,
  validateV1MigrationReadiness,
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
    contents: [{
      content_id: "content-1",
      content_type: "PROPOSITION",
      payload: "Sõna on üks keeleline üksus.",
      language: "et",
      domain: "linguistics",
      referent_refs: [],
      evidence_refs: ["evidence-1"],
      attribution: { kind: "SOURCE", actor_ref: "actor:user" },
      confidence: 0.99
    }],
    senses: [{
      sense_id: "sense-meaning",
      content_refs: ["content-1"],
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
      content_refs: ["content-1"],
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

test("v2 has separate FORM, CONTENT and SENSE layers", () => {
  assert.equal(WORD_SEMANTIC_SCHEMA, "kratt-word-semantics/v2");
  assert.deepEqual(SEMANTIC_LAYERS, ["FORM", "CONTENT", "SENSE", "PRINCIPLE", "INTENT", "SPEECH_ACT", "EFFECT", "POWER", "AUTHORITY"]);
  const record = make();
  assert.equal(record.contents[0].payload, "Sõna on üks keeleline üksus.");
  assert.equal(record.senses[0].definition, "Kontekstuaalne tähendus");
  assert.notEqual(record.contents[0].payload, record.senses[0].definition);
});

test("same surface form can carry distinct high-confidence senses and requires review", () => {
  const record = make();
  record.senses.push({
    sense_id: "sense-principle",
    content_refs: ["content-1"],
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
  assert.equal(AMBIGUITY_CONFIDENCE_THRESHOLD, 0.8);
});

test("different content nodes do not create false sense ambiguity", () => {
  const record = make();
  record.contents.push({
    content_id: "content-2",
    content_type: "TOPIC",
    payload: "Keeleline väljendus kui suhtlusvahend.",
    language: "et",
    domain: "communication",
    referent_refs: [],
    evidence_refs: ["evidence-2"],
    attribution: { kind: "SOURCE", actor_ref: "actor:user" },
    confidence: 0.97
  });
  record.senses.push({
    sense_id: "sense-communication",
    content_refs: ["content-2"],
    definition: "Suhtlusvahend või väljendusüksus",
    language: "et",
    domain: "communication",
    concept_ref: "concept:communication",
    confidence: 0.92,
    evidence_refs: ["evidence-2"]
  });
  const result = evaluateWordSemantics(record, { now });
  assert.equal(result.status, "SEMANTICALLY_STRUCTURED");
  assert.deepEqual(result.ambiguous_sense_ids, []);
});

test("sense cannot exist without a source-grounded content node", () => {
  const record = make();
  record.contents = [];
  assert.equal(validateWordSemanticRecord(record).reason, "SENSE_FIELDS_INVALID");
});

test("speech acts point to content nodes instead of duplicating proposition text", () => {
  const record = make();
  assert.equal(Object.hasOwn(record.speech_acts[0], "propositional_content"), false);
  record.speech_acts[0].content_refs = ["unknown-content"];
  assert.equal(validateWordSemanticRecord(record).reason, "SPEECH_ACT_FIELDS_INVALID");
});

test("quoted content preserves attribution and does not self-promote to a live instruction", () => {
  const record = make();
  record.contents[0].content_type = "QUOTED_TEXT";
  record.contents[0].attribution = { kind: "QUOTED", actor_ref: "actor:external" };
  assert.equal(validateWordSemanticRecord(record).ok, true);
  const result = evaluateWordSemantics(record, { now });
  assert.equal(result.authorization_granted, false);
  assert.equal(result.policy_authority, false);
});

test("semantic interpretation never grants policy authority", () => {
  const result = evaluateWordSemantics(make(), { now, requiredLayers: ["CONTENT", "SENSE", "AUTHORITY"] });
  assert.equal(result.ok, true);
  assert.equal(result.authorization_granted, false);
  assert.equal(result.policy_authority, false);
  assert.deepEqual(result.authority_candidates, ["auth-1"]);
});

test("asserted effect is not silently promoted to causal fact", () => {
  const result = evaluateWordSemantics(make(), { now, requiredLayers: ["EFFECT"] });
  assert.deepEqual(result.effects_without_causal_establishment, ["effect-1"]);
});

test("revoked authority is surfaced as a conflict", () => {
  const record = make();
  record.authorities[0].status = "REVOKED";
  const result = evaluateWordSemantics(record, { now });
  assert.equal(result.status, "AUTHORITY_CONFLICT");
});

test("missing normative layer requires review when it is required", () => {
  const record = make();
  record.principles = [];
  const result = evaluateWordSemantics(record, { now, requiredLayers: ["PRINCIPLE"] });
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

test("semantic node identifiers must be unique across layers", () => {
  const record = make();
  record.principles[0].principle_id = "sense-meaning";
  assert.equal(validateWordSemanticRecord(record).reason, "SEMANTIC_NODE_ID_COLLISION");
});

test("v1 migration refuses to fabricate content from sense definitions", () => {
  const result = validateV1MigrationReadiness({ schema_version: "kratt-word-semantics/v1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXPLICIT_CONTENT_REAUTHORING_REQUIRED");
});
