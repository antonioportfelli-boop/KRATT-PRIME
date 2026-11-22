import test from "node:test";
import assert from "node:assert/strict";
import { createSemanticAgentPipeline } from "../src/semantic-agent-pipeline.mjs";
import { createWordSemanticRecord } from "../../kratt-core/src/word-semantic-model.mjs";
import { createMotlemineEngine } from "../../kratt-core/src/motlemine-engine.mjs";

function record() {
  return createWordSemanticRecord({
    recordId: "pipeline-record-01",
    sourceRef: "github:source-01",
    sourceDigest: "a".repeat(64),
    sourceEvidenceId: "evidence-source-01",
    contextId: "ctx:test",
    createdAt: "2026-11-22T10:00:00.000Z",
    form: { token_id: "token-01", surface: "sisu", language: "et", normalization: "NFC", span: { start: 0, end: 4 } },
    contents: [{
      content_id: "content-01", content_type: "PROPOSITION", payload: "Kontrollitav sisu.",
      language: "et", domain: "test", referent_refs: [], evidence_refs: ["evidence-source-01"],
      attribution: { kind: "SOURCE", actor_ref: "actor:user" }, confidence: 0.95
    }],
    senses: [{
      sense_id: "sense-01", content_refs: ["content-01"], definition: "Kontekstuaalne tähendus",
      language: "et", domain: "test", concept_ref: null, confidence: 0.9,
      evidence_refs: ["evidence-source-01"]
    }],
    principles: [], intents: [], speechActs: [], effects: [], powers: [], authorities: []
  }).value;
}
function agents({ verdict = "ACCEPT", failAt = null } = {}) {
  const stages = [];
  const fn = name => async input => {
    stages.push(name);
    if (failAt === name) return { ok: false, reason: "test" };
    if (name === "EXTRACT_SOURCE") return { record: record() };
    if (name === "REVIEW") return { verdict, issues: verdict === "ACCEPT" ? [] : ["ambiguity"] };
    return { record: input.record };
  };
  return { stages, extractSource: fn("EXTRACT_SOURCE"), contextualize: fn("CONTEXTUALIZE"),
    classifySemantics: fn("CLASSIFY_SEMANTICS"), review: fn("REVIEW") };
}
test("runs extraction, context, classification and critic before gated ingestion", async () => {
  const a = agents(), events = [], calls = [];
  const pipeline = createSemanticAgentPipeline({
    ...a, onStage: event => events.push(event),
    ingestion: { ingest: async input => { calls.push(input); return { ok: true, status: "STORED" }; } }
  });
  const result = await pipeline.run({ requestId: "req-pipe-01", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "STORED");
  assert.deepEqual(a.stages, ["EXTRACT_SOURCE", "CONTEXTUALIZE", "CLASSIFY_SEMANTICS", "REVIEW"]);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 6);
  assert.equal(events[0].stage, "EXTRACT_SOURCE");
  assert.equal(events[1].stage, "TALMUD_PREFLIGHT");
  assert.equal(events.at(-1).stage, "ANTI_TALMUD_POSTFLIGHT");
  assert.equal(result.truthChain.status, "CLEAR_FOR_POLICY_GATE");
});
test("critic REVISE prevents memory ingestion", async () => {
  const a = agents({ verdict: "REVISE" }); let ingested = false;
  const pipeline = createSemanticAgentPipeline({ ...a, ingestion: { ingest: async () => { ingested = true; } } });
  const result = await pipeline.run({ requestId: "req-pipe-02", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(ingested, false);
});
test("stage rejection halts downstream agents", async () => {
  const a = agents({ failAt: "CONTEXTUALIZE" }); let ingested = false;
  const pipeline = createSemanticAgentPipeline({ ...a, ingestion: { ingest: async () => { ingested = true; } } });
  const result = await pipeline.run({ requestId: "req-pipe-03", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "BLOCKED");
  assert.equal(ingested, false);
  assert.deepEqual(a.stages, ["EXTRACT_SOURCE", "CONTEXTUALIZE"]);
});
test("audit sink failure fails closed before memory ingestion", async () => {
  const a = agents(); let ingested = false;
  const pipeline = createSemanticAgentPipeline({ ...a, onStage: async () => { throw new Error("audit unavailable"); },
    ingestion: { ingest: async () => { ingested = true; } } });
  const result = await pipeline.run({ requestId: "req-pipe-04", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.reason, "SEMANTIC_STAGE_AUDIT_FAILED:EXTRACT_SOURCE");
  assert.equal(ingested, false);
});
test("contextualization cannot rewrite the source-grounded content", async () => {
  const a = agents(); let ingested = false;
  a.contextualize = async input => ({ record: {
    ...input.record,
    contents: input.record.contents.map(content => ({ ...content, payload: "silently substituted" }))
  } });
  const pipeline = createSemanticAgentPipeline({ ...a, ingestion: { ingest: async () => { ingested = true; } } });
  const result = await pipeline.run({ requestId: "req-pipe-05", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SEMANTIC_ORIGIN_MUTATED_AFTER_EXTRACTION");
  assert.equal(ingested, false);
});
test("classification cannot replace the source occurrence or lexical form", async () => {
  const a = agents(); let ingested = false;
  a.classifySemantics = async input => ({ record: {
    ...input.record,
    form: { ...input.record.form, surface: "peegeldus" }
  } });
  const pipeline = createSemanticAgentPipeline({ ...a, ingestion: { ingest: async () => { ingested = true; } } });
  const result = await pipeline.run({ requestId: "req-pipe-06", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SEMANTIC_ORIGIN_MUTATED_AFTER_CLASSIFICATION");
  assert.equal(ingested, false);
});

test("Anti-Talmud postflight blocks a revoked authority claim before ingestion", async () => {
  const a = agents(); let ingested = false;
  a.classifySemantics = async input => ({
    record: {
      ...input.record,
      authorities: [{
        authority_id: "authority-revoked",
        authority_type: "DELEGATED",
        issuer_ref: "actor:owner",
        subject_ref: "actor:agent",
        action_scope: "semantic.memory.append",
        resource_scope: "semantic-record:*",
        jurisdiction: "KRATT",
        valid_from: null,
        valid_until: null,
        evidence_refs: ["evidence-source-01"],
        status: "REVOKED"
      }]
    }
  });
  const pipeline = createSemanticAgentPipeline({
    ...a,
    ingestion: { ingest: async () => { ingested = true; return { ok: true, status: "STORED" }; } }
  });
  const result = await pipeline.run({ requestId: "req-pipe-07", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.ok(result.correctionProposals.some(item => item.code === "REVOKED_AUTHORITY_CONFLICT"));
  assert.equal(ingested, false);
});

test("Talmud preflight blocks source-unanchored content before contextualization", async () => {
  const a = agents(); let contextualized = false; let ingested = false;
  a.extractSource = async () => ({
    record: {
      ...record(),
      contents: record().contents.map(content => ({ ...content, evidence_refs: ["other-evidence"] }))
    }
  });
  a.contextualize = async input => { contextualized = true; return { record: input.record }; };
  const pipeline = createSemanticAgentPipeline({
    ...a, ingestion: { ingest: async () => { ingested = true; } }
  });
  const result = await pipeline.run({ requestId: "req-pipe-08", principalId: "agent-pipe-01", source: {}, context: {} });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SOURCE_CONTENT_NOT_BOUND_TO_SOURCE_EVIDENCE");
  assert.equal(contextualized, false);
  assert.equal(ingested, false);
});

test("pipeline can enforce independent MÕTLEMINE evidence review at both gates", async () => {
  const at = "2026-11-22T10:00:00.000Z";
  const evidence = ["source-one", "source-two"].map((sourceId, index) => ({
    schema_version: "kratt-prime/v0.1",
    evidence_id: "reflection-evidence-" + index,
    subject: "claim-subject",
    claim_type: "TESTS_PASSED",
    source: { source_type: "github", source_id: sourceId, revision: null },
    observed_at: at,
    verification_method: "signed-attestation",
    result: "VERIFIED",
    artifact_digest: null,
    metadata: {}
  }));
  const reflection = {
    analysis_id: "pipeline-reflection-01",
    evidence,
    claims: [{
      claim_id: "claim-pipeline",
      statement: "Two independent sources corroborate this claim.",
      depends_on: [],
      assessments: evidence.map(item => ({
        evidence_id: item.evidence_id, stance: "SUPPORTS", rationale_code: "independent-attestation"
      }))
    }]
  };
  const a = agents(), engine = createMotlemineEngine({ verifyEvidence: () => true, minIndependentSources: 2 });
  const pipeline = createSemanticAgentPipeline({
    ...a, reflectionEngine: engine, requireReflection: true,
    ingestion: { ingest: async () => ({ ok: true, status: "STORED" }) }
  });
  const result = await pipeline.run({
    requestId: "req-pipe-09", principalId: "agent-pipe-01", source: {}, context: {},
    preflightReflection: reflection, postflightReflection: reflection
  });
  assert.equal(result.status, "STORED");
  assert.equal(result.truthChain.reflection_status, "READY_FOR_REVIEW");
});
