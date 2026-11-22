import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";
import { createSemanticEvidenceBridge } from "../src/semantic-evidence-bridge.mjs";
import { createSemanticIngestionRuntime } from "../src/semantic-ingestion-runtime.mjs";
import { createWordSemanticRecord } from "../src/word-semantic-model.mjs";

const at = "2026-11-22T10:30:00.000Z";
const sourceDigest = "d".repeat(64);
const requestId = "request-semantic-01";
const principalId = "agent-lexical-01";

function sourceEvidence() {
  return {
    schema_version: KRATT_SCHEMA_VERSION,
    evidence_id: "evidence-source-01",
    subject: "semantic-record-01",
    claim_type: "ARTIFACT_CREATED",
    source: { source_type: "github", source_id: "semantic-source", revision: null },
    observed_at: at,
    verification_method: "trusted-digest-verifier",
    result: "VERIFIED",
    artifact_digest: "sha256:" + sourceDigest,
    metadata: {}
  };
}

function makeRecord() {
  const created = createWordSemanticRecord({
    recordId: "semantic-record-01",
    sourceRef: "github:semantic-source",
    sourceDigest,
    sourceEvidenceId: "evidence-source-01",
    contextId: "ctx:engineering",
    createdAt: at,
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
      payload: "Algallikast pärinev kontrollitud sisu.",
      language: "et",
      domain: "linguistics",
      referent_refs: [],
      evidence_refs: ["evidence-source-01"],
      attribution: { kind: "SOURCE", actor_ref: "actor:user" },
      confidence: 1
    }],
    senses: [{
      sense_id: "sense-01",
      content_refs: ["content-01"],
      definition: "Kontekstuaalne tõlgendus",
      language: "et",
      domain: "linguistics",
      concept_ref: null,
      confidence: 0.9,
      evidence_refs: ["evidence-source-01"]
    }],
    principles: [],
    intents: [],
    speechActs: [],
    effects: [],
    powers: [],
    authorities: []
  });
  assert.equal(created.ok, true, created.reason);
  return structuredClone(created.value);
}

function setup({ authorize, verifyEvidence = () => true, loadEvidence } = {}) {
  const ledger = new MemoryLedger();
  const bridge = createSemanticEvidenceBridge({ ledger, verifyEvidence });
  const runtime = createSemanticIngestionRuntime({
    authorize: authorize ?? (async request => ({
      decision: "ALLOW",
      decision_id: "decision-semantic-01",
      request_id: request.requestId,
      principal_id: request.principalId,
      action: request.action,
      resource: request.resource,
      record_digest: request.recordDigest
    })),
    loadEvidence: loadEvidence ?? (async () => [sourceEvidence()]),
    bridge
  });
  return { runtime, ledger };
}

test("stores a semantic record only after exact request-bound policy ALLOW", async () => {
  const { runtime, ledger } = setup();
  const result = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(result.ok, true);
  assert.equal(result.status, "STORED");
  assert.equal(result.authorizationScope, "semantic.memory.append");
  assert.equal(result.writeAuthorized, true);
  assert.equal(result.policyAuthority, false);
  assert.equal(result.semanticAuthority, false);
  assert.equal(result.externalWritesStarted, false);
  assert.equal(ledger.list({ kind: "WORD_SEMANTIC_RECORD" }).length, 1);
});

test("policy DENY prevents evidence loading and memory mutation", async () => {
  let evidenceLoaded = false;
  const { runtime, ledger } = setup({
    authorize: async request => ({
      decision: "DENY",
      decision_id: "decision-deny-01",
      request_id: request.requestId,
      principal_id: request.principalId,
      action: request.action,
      resource: request.resource,
      record_digest: request.recordDigest,
      reason: "SCOPE_NOT_GRANTED"
    }),
    loadEvidence: async () => { evidenceLoaded = true; return [sourceEvidence()]; }
  });
  const result = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(result.status, "DENIED");
  assert.equal(result.reason, "SCOPE_NOT_GRANTED");
  assert.equal(evidenceLoaded, false);
  assert.equal(ledger.size, 0);
});

test("non-request-bound or digest-mismatched ALLOW is blocked", async () => {
  const { runtime, ledger } = setup({
    authorize: async request => ({
      decision: "ALLOW",
      decision_id: "decision-unbound-01",
      request_id: "another-request",
      principal_id: request.principalId,
      action: request.action,
      resource: request.resource,
      record_digest: "sha256:" + "f".repeat(64)
    })
  });
  const result = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(result.reason, "SEMANTIC_DECISION_NOT_REQUEST_BOUND");
  assert.equal(ledger.size, 0);
});

test("REQUIRE_APPROVAL returns pending without evidence loading or memory mutation", async () => {
  let evidenceLoaded = false;
  const { runtime, ledger } = setup({
    authorize: async request => ({
      decision: "REQUIRE_APPROVAL",
      decision_id: "decision-pending-01",
      request_id: request.requestId,
      principal_id: request.principalId,
      action: request.action,
      resource: request.resource,
      record_digest: request.recordDigest
    }),
    loadEvidence: async () => { evidenceLoaded = true; return [sourceEvidence()]; }
  });
  const result = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(result.status, "WAITING_APPROVAL");
  assert.equal(evidenceLoaded, false);
  assert.equal(ledger.size, 0);
});

test("independent evidence verifier still controls ingestion after policy ALLOW", async () => {
  const { runtime, ledger } = setup({ verifyEvidence: () => false });
  const result = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /^SEMANTIC_EVIDENCE_TRUST_CHECK_FAILED/);
  assert.equal(ledger.size, 0);
});

test("evidence loading errors fail closed", async () => {
  const { runtime, ledger } = setup({
    loadEvidence: async () => { throw new Error("evidence store offline"); }
  });
  const result = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(result.reason, "SEMANTIC_EVIDENCE_UNAVAILABLE");
  assert.equal(ledger.size, 0);
});

test("invalid semantic records cannot reach policy, evidence or memory", async () => {
  let policyCalled = false;
  let evidenceLoaded = false;
  const { runtime, ledger } = setup({
    authorize: async request => {
      policyCalled = true;
      return {
        decision: "ALLOW", decision_id: "decision-01", request_id: request.requestId,
        principal_id: request.principalId, action: request.action,
        resource: request.resource, record_digest: request.recordDigest
      };
    },
    loadEvidence: async () => { evidenceLoaded = true; return [sourceEvidence()]; }
  });
  const invalid = makeRecord();
  invalid.source.source_evidence_id = "";
  const result = await runtime.ingest({ requestId, principalId, record: invalid });
  assert.equal(result.status, "BLOCKED");
  assert.equal(policyCalled, false);
  assert.equal(evidenceLoaded, false);
  assert.equal(ledger.size, 0);
});

test("same record replay reports duplicate without adding another entry", async () => {
  const { runtime, ledger } = setup();
  const first = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  const second = await runtime.ingest({ requestId, principalId, record: makeRecord() });
  assert.equal(first.status, "STORED");
  assert.equal(second.status, "DUPLICATE");
  assert.equal(ledger.list({ kind: "WORD_SEMANTIC_RECORD" }).length, 1);
});
