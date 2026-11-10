import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRootSnapshot, validateRootDelta } from "../src/reflection-root-store.mjs";
import { buildReflectionRootDelta, createTelegramReflectionDeltaBuilder } from "../src/reflection-engine.mjs";
import { KRATT_ONTOLOGY_VERSION } from "../src/reflection-ontology.mjs";
import { createTelegramReflectionProposalService } from "../src/telegram-reflection-proposal.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function node(id, type, attributes, createdAt = "2026-11-10T14:00:00.000Z") {
  const payload = { id, type, createdAt, attributes };
  return { ...payload, recordDigest: digest(canonical(payload)) };
}
function edge(id, from, to, relation) {
  const payload = { id, from, to, relation, createdAt: "2026-11-10T14:00:00.000Z" };
  return { ...payload, recordDigest: digest(canonical(payload)) };
}
function baseDocument() {
  const source = node("source-1", "SOURCE", { sourceDigest: digest("source-1"), observedAt: "2026-11-10T13:00:00.000Z", rightsStatus: "permitted" });
  const segment = node("segment-1", "SEGMENT", { sourceId: "source-1", startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") });
  const claim = node("claim-1", "CLAIM", {
    normalizedText: "The system status is active", subjectId: "system-1", predicate: "status", objectValue: "active",
    timeScope: "2026-Q4", extractionMethod: "model", claimStatus: "UNREVIEWED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source-1"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") }],
  });
  const evidence = node("evidence-1", "EVIDENCE", {
    sourceId: "source-1", sourceDigest: digest("source-1"), claimId: "claim-1", stance: "supports",
    integrityStatus: "VERIFIED", sourceLineageId: "lineage-1", independenceGroupId: "wire-group-1",
  });
  return {
    nodes: [source, segment, claim, evidence],
    edges: [
      edge("edge-1", "source-1", "segment-1", "SOURCE_HAS_SEGMENT"),
      edge("edge-2", "segment-1", "claim-1", "SEGMENT_SUPPORTS_CLAIM"),
      edge("edge-3", "evidence-1", "claim-1", "EVIDENCE_SUPPORTS_CLAIM"),
    ],
    metadata: { ontologyVersion: KRATT_ONTOLOGY_VERSION },
  };
}
const NOW = () => "2026-11-10T15:00:00.000Z";

test("reflection reducer creates a digest-bound RootDelta and leaves the root untouched", () => {
  const snapshot = createRootSnapshot(baseDocument(), { version: 7, createdAt: "2026-11-10T14:30:00.000Z" });
  const claim = node("claim-2", "CLAIM", {
    normalizedText: "The system status is inactive", subjectId: "system-1", predicate: "status", objectValue: "inactive",
    timeScope: "2026-Q4", extractionMethod: "model", claimStatus: "UNREVIEWED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source-1"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") }],
  });
  const source2 = node("source-2", "SOURCE", { sourceDigest: digest("source-2"), observedAt: "2026-11-10T13:30:00.000Z", rightsStatus: "permitted" });
  const evidence2 = node("evidence-2", "EVIDENCE", {
    sourceId: "source-2", sourceDigest: digest("source-2"), claimId: "claim-1", stance: "supports",
    integrityStatus: "VERIFIED", sourceLineageId: "lineage-1", independenceGroupId: "wire-group-1",
  });

  const result = buildReflectionRootDelta({ snapshot, nodes: [claim, source2, evidence2], now: NOW });
  assert.equal(result.status, "PROPOSED");
  assert.equal(result.proposal.status, "PROPOSAL_ONLY");
  assert.equal(result.proposal.applyStatus, "NOT_APPLIED");
  assert.equal(result.proposal.expectedRootVersion, 7);
  assert.equal(result.proposal.requiresArchitectApproval, true);
  assert.equal(result.proposal.claimPromotion, "FORBIDDEN");
  assert.equal(result.proposal.statistics.contradictionCandidatesAdded, 1);
  assert.equal(result.proposal.statistics.verifiedEvidenceCount, 2);
  assert.equal(result.proposal.statistics.independentEvidenceGroups, 1);
  assert.equal(result.proposal.statistics.dependentEvidenceCopies, 1);
  assert.equal(validateRootDelta(result.proposal.rootDelta).ok, true);
  assert.ok(result.proposal.rootDelta.operations.some(op => op.value?.type === "CONTRADICTION"));
  assert.ok(result.proposal.rootDelta.operations.some(op => op.value?.type === "BRANCH_RUN"));
  assert.equal(snapshot.document.nodes.some(item => item.id === "claim-2"), false);
  assert.equal(snapshot.document.nodes.find(item => item.id === "claim-1").attributes.claimStatus, "UNREVIEWED");
});

test("reflection reducer does not infer contradictions across different time scopes", () => {
  const snapshot = createRootSnapshot(baseDocument(), { version: 2, createdAt: "2026-11-10T14:30:00.000Z" });
  const claim = node("claim-2", "CLAIM", {
    normalizedText: "The system status is inactive", subjectId: "system-1", predicate: "status", objectValue: "inactive",
    timeScope: "2027-Q1", extractionMethod: "model", claimStatus: "UNREVIEWED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source-1"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") }],
  });
  const result = buildReflectionRootDelta({ snapshot, nodes: [claim], now: NOW });
  assert.equal(result.status, "PROPOSED");
  assert.equal(result.proposal.statistics.contradictionCandidatesAdded, 0);
});

test("reflection reducer rejects stale roots, ID collisions and attempted model promotion", () => {
  const snapshot = createRootSnapshot(baseDocument(), { version: 1, createdAt: "2026-11-10T14:30:00.000Z" });
  assert.equal(buildReflectionRootDelta({ snapshot: { ...snapshot, digest: digest("wrong") }, nodes: [node("new", "SOURCE", { sourceDigest: digest("x"), observedAt: NOW(), rightsStatus: "permitted" })], now: NOW }).reason, "REFLECTION_ENGINE_ROOT_DIGEST_MISMATCH");
  assert.equal(buildReflectionRootDelta({ snapshot, nodes: [snapshot.document.nodes[0]], now: NOW }).reason, "REFLECTION_ENGINE_NODE_ID_CONFLICT");
  const promoted = node("claim-2", "CLAIM", {
    normalizedText: "Promoted model claim", subjectId: "system-1", predicate: "status", objectValue: "inactive",
    timeScope: "2026-Q4", extractionMethod: "model", claimStatus: "APPROVED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source-1"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") }],
  });
  assert.equal(buildReflectionRootDelta({ snapshot, nodes: [promoted], now: NOW }).status, "DENY");
});


test("Telegram proposal bridge re-reads and binds the authoritative root before building a RootDelta", async () => {
  const snapshot = createRootSnapshot(baseDocument(), { version: 3, createdAt: "2026-11-10T14:30:00.000Z" });
  const candidate = node("claim-bridge", "CLAIM", {
    normalizedText: "The system status is inactive", subjectId: "system-1", predicate: "status", objectValue: "inactive",
    timeScope: "2026-Q4", extractionMethod: "model", claimStatus: "UNREVIEWED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source-1"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") }],
  });
  const builder = createTelegramReflectionDeltaBuilder({
    rootSnapshotProvider: { getSnapshot: () => ({ status: "OK", snapshot }) },
    collectCandidateNodes: () => [candidate],
    now: NOW,
  });
  const rootDelta = await builder({
    decision: { decision: "APPROVE", decisionId: "signed-decision" },
    projection: { claimId: "claim-1" },
    expectedRoot: { rootVersion: snapshot.version, rootDigest: snapshot.digest },
  });
  assert.equal(validateRootDelta(rootDelta).ok, true);
  assert.ok(rootDelta.operations.some(operation => operation.value?.type === "CONTRADICTION"));

  const stale = createTelegramReflectionDeltaBuilder({
    rootSnapshotProvider: { getSnapshot: () => ({ status: "OK", snapshot }) },
    collectCandidateNodes: () => [candidate],
    now: NOW,
  });
  await assert.rejects(() => stale({
    expectedRoot: { rootVersion: snapshot.version + 1, rootDigest: snapshot.digest },
  }), /TELEGRAM_REFLECTION_DELTA_ROOT_CHANGED/);
});


test("durable Telegram approval proposal service can use the deterministic reflection reducer", async () => {
  const snapshot = createRootSnapshot(baseDocument(), { version: 9, createdAt: "2026-11-10T14:30:00.000Z" });
  const candidate = node("claim-telegram-2", "CLAIM", {
    normalizedText: "The system status is inactive", subjectId: "system-1", predicate: "status", objectValue: "inactive",
    timeScope: "2026-Q4", extractionMethod: "model", claimStatus: "UNREVIEWED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source-1"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt-1") }],
  });
  const decision = {
    schemaVersion: "kratt-telegram-validation-decision/v1",
    requestId: "request-reflection-1",
    decisionId: "decision-reflection-1",
    decision: "APPROVE",
    verifiedAt: "2026-11-10T14:59:00.000Z",
    claimId: "claim-1",
    targetDigest: digest("target-claim"),
    evidenceSnapshotDigest: digest("evidence-snapshot"),
    rootDigest: snapshot.digest,
    policyVersion: "strict/v1",
  };
  const request = {
    requestId: decision.requestId,
    claimId: decision.claimId,
    targetDigest: decision.targetDigest,
    evidenceSnapshotDigest: decision.evidenceSnapshotDigest,
    rootDigest: decision.rootDigest,
    policyVersion: decision.policyVersion,
  };
  const builder = createTelegramReflectionDeltaBuilder({
    rootSnapshotProvider: { getSnapshot: () => ({ status: "OK", snapshot }) },
    collectCandidateNodes: () => [candidate],
    now: NOW,
  });
  const service = createTelegramReflectionProposalService({
    decisionStore: {
      getReviewRequest: () => ({ state: "CONSUMED", request }),
      getDecision: () => decision,
    },
    projectionService: {
      get: async () => ({
        readOnly: true, truthVerdict: "NOT_ASSERTED", claimId: "claim-1",
        claimDigest: digest("target-claim"), evidenceSnapshotDigest: digest("evidence-snapshot"),
        rootDigest: snapshot.digest, rootVersion: snapshot.version,
      }),
    },
    buildRootDelta: builder,
  });
  const result = await service.createProposal({ requestId: decision.requestId });
  assert.equal(result.status, "OK");
  assert.equal(result.proposal.status, "PROPOSAL_ONLY");
  assert.equal(result.proposal.applyStatus, "NOT_APPLIED");
  assert.equal(validateRootDelta(result.proposal.rootDelta).ok, true);
  assert.ok(result.proposal.rootDelta.operations.some(operation => operation.value?.type === "CONTRADICTION"));
});
