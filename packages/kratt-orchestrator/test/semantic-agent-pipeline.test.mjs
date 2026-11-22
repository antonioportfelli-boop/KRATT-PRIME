import test from "node:test";
import assert from "node:assert/strict";
import { createSemanticAgentPipeline } from "../src/semantic-agent-pipeline.mjs";
import { createWordSemanticRecord } from "../../kratt-core/src/word-semantic-model.mjs";

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
  assert.equal(events.length, 4);
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
