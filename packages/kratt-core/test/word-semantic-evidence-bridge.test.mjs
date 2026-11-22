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
  const stored = ledger.list({ kind: "WORD_SEMANTIC_RECORD" })[0].record.payload;
  assert.equal(stored.provenance_graph.schema_version, "kratt-semantic-provenance-graph/v1");
  for (const type of ["SOURCE_OCCURRENCE", "FORM", "CONTENT", "SENSE"]) {
    const node = stored.provenance_graph.nodes.find(item => item.type === type);
    assert.ok(node, "missing graph node type " + type);
    assert.ok(node.evidence_ids.length > 0);
  }
  assert.ok(stored.provenance_graph.edges.some(edge => edge.relation === "INTERPRETED_AS"));
  assert.equal(stored.policy_authority, false);
  assert.equal(stored.authorization_granted, false);
  assert.equal(result.graphDigest, stored.provenance_graph.graph_digest);
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

test("provenance graph preserves every semantic layer and its evidence edges", async () => {
  const { ledger, bridge } = makeBridge();
  const record = semanticRecord();
  record.principles.push({
    principle_id: "principle-01",
    statement: "Principles require explicit source evidence.",
    norm_type: "OPERATIONAL",
    jurisdiction: "KRATT",
    valid_from: null,
    valid_until: null,
    source_refs: ["evidence-source"]
  });
  record.intents.push({
    intent_id: "intent-01",
    actor_ref: "actor:user",
    goal: "Separate intent from meaning.",
    audience_refs: ["actor:agent"],
    context_ref: "ctx:engineering",
    attribution_kind: "INFERRED",
    confidence: 0.9,
    evidence_refs: ["evidence-source"]
  });
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
  record.powers.push({
    power_id: "power-01",
    power_type: "INSTITUTIONAL",
    holder_ref: "actor:owner",
    target_refs: ["system:kratt"],
    mechanism: "Policy control",
    scope: "Feature branch",
    evidence_refs: ["evidence-source"]
  });
  record.authorities.push({
    authority_id: "authority-01",
    authority_type: "DELEGATED",
    issuer_ref: "actor:owner",
    subject_ref: "actor:agent",
    action_scope: "Prepare patch",
    resource_scope: "feature/*",
    jurisdiction: "KRATT",
    valid_from: now,
    valid_until: null,
    evidence_refs: ["evidence-source"],
    status: "CANDIDATE"
  });

  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.ok, true);
  const payload = ledger.list({ kind: "WORD_SEMANTIC_RECORD" })[0].record.payload;
  const expectedTypes = ["SOURCE_OCCURRENCE", "FORM", "CONTENT", "SENSE", "PRINCIPLE", "INTENT", "SPEECH_ACT", "EFFECT", "POWER", "AUTHORITY_CLAIM", "EVIDENCE"];
  for (const type of expectedTypes) {
    const node = payload.provenance_graph.nodes.find(item => item.type === type);
    assert.ok(node, "missing provenance node " + type);
    assert.ok(node.evidence_ids.length > 0, "missing evidence reference on " + type);
  }
  assert.ok(payload.provenance_graph.edges.some(edge => edge.relation === "ATTRIBUTED_INTENT"));
  assert.ok(payload.provenance_graph.edges.some(edge => edge.relation === "PERFORMS_SPEECH_ACT"));
  assert.ok(payload.provenance_graph.edges.some(edge => edge.relation === "HAS_EFFECT_CLAIM"));
  assert.ok(payload.provenance_graph.edges.some(edge => edge.relation === "HAS_AUTHORITY_CLAIM"));
  assert.equal(result.authorizationGranted, false);
});

test("verified authority evidence is not treated as execution authorization", async () => {
  const { ledger, bridge } = makeBridge();
  const record = semanticRecord();
  record.authorities.push({
    authority_id: "authority-verified",
    authority_type: "DELEGATED",
    issuer_ref: "actor:owner",
    subject_ref: "actor:agent",
    action_scope: "Propose code",
    resource_scope: "feature/*",
    jurisdiction: "KRATT",
    valid_from: now,
    valid_until: null,
    evidence_refs: ["evidence-source"],
    status: "VERIFIED"
  });
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.ok, true);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(ledger.verify().ok, true);
});

test("effect measurement evidence remains distinct from effect claim evidence", async () => {
  const { ledger, bridge } = makeBridge();
  const record = semanticRecord();
  record.effects.push({
    effect_id: "effect-measured",
    effect_type: "TECHNICAL",
    target_refs: ["system:kratt"],
    direction: "POSITIVE",
    magnitude: 1,
    evidence_refs: ["evidence-source"],
    measurement_refs: ["evidence-measurement"],
    causal_status: "CAUSALLY_ESTABLISHED"
  });
  const measurement = evidence(
    "evidence-measurement",
    "measurement-run",
    "sha256:" + "c".repeat(64)
  );
  const result = await bridge.ingest({
    record,
    evidence: [evidence("evidence-source"), measurement]
  });
  assert.equal(result.ok, true);
  const graph = ledger.list({ kind: "WORD_SEMANTIC_RECORD" })[0].record.payload.provenance_graph;
  const effectNode = graph.nodes.find(node => node.id === "effect:effect-measured");
  assert.deepEqual(effectNode.evidence_ids, ["evidence-source"]);
  assert.ok(graph.edges.some(edge =>
    edge.from === "effect:effect-measured" && edge.to === "evidence:evidence-measurement"
      && edge.relation === "MEASURED_BY"
  ));
  assert.ok(graph.edges.some(edge =>
    edge.from === "effect:effect-measured" && edge.to === "evidence:evidence-source"
      && edge.relation === "SUPPORTED_BY"
  ));
  assert.equal(result.authorizationGranted, false);
});

test("candidate authority evidence references cannot be omitted from verification", async () => {
  const { ledger, bridge } = makeBridge();
  const record = semanticRecord();
  record.authorities.push({
    authority_id: "authority-candidate",
    authority_type: "DELEGATED",
    issuer_ref: "actor:owner",
    subject_ref: "actor:agent",
    action_scope: "Prepare a draft patch",
    resource_scope: "feature/*",
    jurisdiction: "KRATT",
    valid_from: now,
    valid_until: null,
    evidence_refs: ["evidence-authority-missing"],
    status: "CANDIDATE"
  });
  const result = await bridge.ingest({
    record,
    evidence: [evidence("evidence-source")]
  });
  assert.equal(result.reason, "SEMANTIC_EVIDENCE_REFERENCE_MISSING:evidence-authority-missing");
  assert.equal(ledger.size, 0);
});

test("generic artifact evidence cannot be relabeled as effect measurement", async () => {
  const { bridge } = makeBridge();
  const record = semanticRecord();
  record.effects.push({
    effect_id: "effect-observed", effect_type: "TECHNICAL", target_refs: ["system:kratt"],
    direction: "POSITIVE", magnitude: 120, evidence_refs: ["evidence-source"],
    measurement_refs: ["evidence-source"], causal_status: "OBSERVED"
  });
  const result = await bridge.ingest({ record, evidence: [evidence("evidence-source")] });
  assert.equal(result.reason, "EFFECT_MEASUREMENT_EVIDENCE_INVALID:evidence-source");
});

test("observed effects require typed measurement evidence bound to the effect and target", async () => {
  const { ledger, bridge } = makeBridge();
  const record = semanticRecord();
  record.effects.push({
    effect_id: "effect-observed", effect_type: "TECHNICAL", target_refs: ["system:kratt"],
    direction: "POSITIVE", magnitude: 120, evidence_refs: ["evidence-source"],
    measurement_refs: ["evidence-measurement"], causal_status: "OBSERVED"
  });
  const measurement = evidence("evidence-measurement", "benchmark-run");
  measurement.claim_type = "MEASUREMENT_RECORDED";
  measurement.metadata = {
    effect_id: "effect-observed",
    target_ref: "system:kratt",
    metric_name: "response-latency",
    metric_value: 120,
    metric_unit: "ms",
    measurement_method: "repeatable-benchmark"
  };
  const result = await bridge.ingest({
    record,
    evidence: [evidence("evidence-source"), measurement]
  });
  assert.equal(result.ok, true);
  const stored = ledger.list({ kind: "WORD_SEMANTIC_RECORD" })[0].record.payload;
  assert.ok(stored.provenance_graph.edges.some(edge =>
    edge.relation === "MEASURED_BY" && edge.to === "evidence:evidence-measurement"
  ));
});

test("causal status requires a typed analysis and established causality requires independent replication", async () => {
  const { bridge } = makeBridge();
  const record = semanticRecord();
  record.effects.push({
    effect_id: "effect-causal", effect_type: "TECHNICAL", target_refs: ["system:kratt"],
    direction: "POSITIVE", magnitude: 120, evidence_refs: ["evidence-source"],
    measurement_refs: ["evidence-measurement"], causal_status: "CAUSALLY_ESTABLISHED"
  });
  const measurement = evidence("evidence-measurement", "benchmark-run");
  measurement.claim_type = "MEASUREMENT_RECORDED";
  measurement.metadata = {
    effect_id: "effect-causal", target_ref: "system:kratt",
    metric_name: "response-latency", metric_value: 120, metric_unit: "ms",
    measurement_method: "repeatable-benchmark"
  };
  const missingCause = await bridge.ingest({
    record, evidence: [evidence("evidence-source"), measurement]
  });
  assert.equal(missingCause.reason, "EFFECT_CAUSAL_ANALYSIS_INDEPENDENCE_REQUIRED");

  const first = evidence("evidence-causal-1", "causal-study-one");
  const second = evidence("evidence-causal-2", "causal-study-two");
  for (const item of [first, second]) {
    item.claim_type = "CAUSAL_ANALYSIS_RECORDED";
    item.metadata = {
      effect_id: "effect-causal",
      analysis_method: "controlled-experiment",
      identification_strategy: "difference-in-differences",
      alternative_hypotheses_considered: true,
      replication_status: "REPLICATED"
    };
  }
  record.effects[0].evidence_refs.push(first.evidence_id, second.evidence_id);
  const isolated = makeBridge();
  const accepted = await isolated.bridge.ingest({
    record, evidence: [evidence("evidence-source"), measurement, first, second]
  });
  assert.equal(accepted.ok, true);
});
