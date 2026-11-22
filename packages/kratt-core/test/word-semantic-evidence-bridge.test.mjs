import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";
import { createSemanticEvidenceBridge } from "../src/semantic-evidence-bridge.mjs";
import { createWordSemanticRecord } from "../src/word-semantic-model.mjs";

const now = "2026-11-22T10:00:00.000Z";
const digest = "b".repeat(64);

function evidence(id, sourceId = "semantic-source", artifactDigest = "sha256:" + digest, result = "VERIFIED") {
  return {
    schema_version: KRATT_SCHEMA_VERSION,
    evidence_id: id,
    subject: "semantic-record-01",
    claim_type: "ARTIFACT_CREATED",
    source: { source_type: "github", source_id: sourceId, revision: null },
    observed_at: now,
    verification_method: "trusted-digest-verifier",
    result,
    artifact_digest: artifactDigest,
    metadata: {}
  };
}

function semanticRecord() {
  const result = createWordSemanticRecord({
    recordId: "semantic-record-01",
    sourceRef: "github:semantic-source",
    sourceDigest: digest,
    sourceEvidenceId: "evidence-source",
    contextId: "ctx:engineering",
    createdAt: now,
    form: {
      token_id: "token-01",
      surface: "sõna",
      language: "et",
      normalization: "NFC",
      span: { start: 0, end: 4 }
    },
    contents: [{
      content_id: "content-01",
      content_type: "PROPOSITION",
      payload: "Sõna on keeleline üksus.",
      language: "et",
      domain: "linguistics",
      referent_refs: [],
      evidence_refs: ["evidence-source"],
      attribution: { kind: "SOURCE", actor_ref: "actor:user" },
      confidence: 0.99
    }],
    senses: [{
      sense_id: "sense-01",
      content_refs: ["content-01"],
      definition: "Kontekstuaalne tähendus",
      language: "et",
      domain: "linguistics",
      concept_ref: null,
      confidence: 0.95,
      evidence_refs: ["evidence-source"]
    }],
    principles: [],
    intents: [],
    speechActs: [],
    effects: [],
    powers: [],
    authorities: []
  });
  assert.equal(result.ok, true, result.reason);
  return structuredClone(result.value);
}

function makeBridge({ verifier = () => true, ledger = new MemoryLedger() } = {}) {
  return { ledger, bridge: createSemanticEvidenceBridge({ ledger, verifyEvidence: verifier }) };
}

test("stores source-bound semantic record only after trusted evidence verification", async () => {
  const { ledger, bridge } = makeBridge();
  const result = await bridge.ingest({ record: semanticRecord(), evidence: [evidence("evidence-source")] });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.semanticStatus, "SEMANTICALLY_STRUCTURED");
  assert.deepEqual(result.evidenceIds, ["evidence-source"]);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(result.durable, false);
  assert.equal(ledger.verify().ok, true);
  assert.equal(ledger.list({ kind: "WORD_SEMANTIC_RECORD" }).length, 1);
});

test("rejects evidence when the independent verifier does not accept it", async () => {
  const { bridge } = makeBridge({ verifier: () => false });
  const result = await bridge.ingest({ record: semanticRecord(), evidence: [evidence("evidence-source")] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^SEMANTIC_EVIDENCE_TRUST_CHECK_FAILED/);
});

test("rejects source evidence whose digest does not bind to the source occurrence", async () => {
  const { bridge } = makeBridge();
  const result = await bridge.ingest({
    record: semanticRecord(),
    evidence: [evidence("evidence-source", "semantic-source", "sha256:" + "c".repeat(64))]
  });
  assert.equal(result.reason, "SOURCE_EVIDENCE_DIGEST_MISMATCH");
});

test("rejects semantic content without evidence provenance", async () => {
  const { bridge } = makeBridge();
  const record = semanticRecord();
  record.contents[0].evidence_refs = [];
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.reason, "SEMANTIC_LAYER_PROVENANCE_REQUIRED");
});

test("rejects dangling semantic evidence references", async () => {
  const { bridge } = makeBridge();
  const record = semanticRecord();
  record.senses[0].evidence_refs = ["missing-evidence"];
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.reason, "SEMANTIC_EVIDENCE_REFERENCE_MISSING:missing-evidence");
});

test("idempotent replay returns the existing memory entry without duplication", async () => {
  const { ledger, bridge } = makeBridge();
  const input = { record: semanticRecord(), evidence: [evidence("evidence-source")] };
  const first = await bridge.ingest(input);
  const second = await bridge.ingest(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(ledger.list({ kind: "WORD_SEMANTIC_RECORD" }).length, 1);
});

test("same record id with changed content is rejected as an identity collision", async () => {
  const { bridge } = makeBridge();
  const first = semanticRecord();
  const second = semanticRecord();
  second.contents[0].payload = "Muudetud algallika sisu.";
  const firstResult = await bridge.ingest({ record: first, evidence: [evidence("evidence-source")] });
  const secondResult = await bridge.ingest({ record: second, evidence: [evidence("evidence-source")] });
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.reason, "SEMANTIC_RECORD_ID_COLLISION");
});

test("source reference must identify the exact evidence source", async () => {
  const { bridge } = makeBridge();
  const record = semanticRecord();
  record.source.source_ref = "sharepoint:different-source";
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.reason, "SOURCE_EVIDENCE_REFERENCE_MISMATCH");
});

test("unverified source evidence cannot enter semantic memory", async () => {
  const { bridge } = makeBridge();
  const result = await bridge.ingest({
    record: semanticRecord(),
    evidence: [evidence("evidence-source", "semantic-source", "sha256:" + digest, "UNAVAILABLE")]
  });
  assert.match(result.reason, /^SEMANTIC_EVIDENCE_NOT_VERIFIED/);
});

test("inferred intent requires linked evidence before memory append", async () => {
  const { bridge } = makeBridge();
  const record = semanticRecord();
  record.intents.push({
    intent_id: "intent-unproven",
    actor_ref: "actor:external",
    goal: "Inferred goal",
    audience_refs: [],
    context_ref: "ctx:engineering",
    attribution_kind: "INFERRED",
    confidence: 0.7,
    evidence_refs: []
  });
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.reason, "SEMANTIC_LAYER_PROVENANCE_REQUIRED");
});

test("speech-act and effect claims carry evidence separately from effect measurements", async () => {
  const { ledger, bridge } = makeBridge();
  const record = semanticRecord();
  record.speech_acts.push({
    act_id: "act-01",
    act_type: "DIRECTIVE",
    speaker_ref: "actor:user",
    addressee_refs: ["actor:agent"],
    content_refs: ["content-01"],
    evidence_refs: ["evidence-source"],
    felicity_conditions: {}
  });
  record.effects.push({
    effect_id: "effect-01",
    effect_type: "TECHNICAL",
    target_refs: ["system:kratt"],
    direction: "POSITIVE",
    magnitude: null,
    evidence_refs: ["evidence-source"],
    measurement_refs: [],
    causal_status: "ASSERTED"
  });
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.ok, true);
  assert.equal(result.authorizationGranted, false);
  assert.equal(ledger.verify().ok, true);
});
