import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  createOntologyValidatedReflectionRootStore,
  createOntologyValidatedTelegramReflectionCasAdapter,
  KRATT_ONTOLOGY_VERSION,
  validateReflectionOntology,
} from "../src/reflection-ontology.mjs";
import { createRootSnapshot } from "../src/reflection-root-store.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function node(id, type, attributes) {
  const value = { id, type, createdAt: "2026-11-10T14:00:00.000Z", attributes };
  return { ...value, recordDigest: digest(canonical(value)) };
}
function validDocument() {
  const source = node("source-1", "SOURCE", {
    sourceDigest: digest("source"), observedAt: "2026-11-10T13:00:00.000Z", rightsStatus: "permitted",
  });
  const segment = node("segment-1", "SEGMENT", {
    sourceId: "source-1", startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt"),
  });
  const claim = node("claim-1", "CLAIM", {
    normalizedText: "A testable proposition", extractionMethod: "model", claimStatus: "UNREVIEWED",
    sourceRefs: [{ segmentId: "segment-1", sourceDigest: digest("source"), startOffset: 0, endOffset: 12, excerptDigest: digest("excerpt") }],
  });
  const evidence = node("evidence-1", "EVIDENCE", {
    sourceId: "source-1", sourceDigest: digest("source"), stance: "supports",
    integrityStatus: "VERIFIED", sourceLineageId: "lineage-1", independenceGroupId: "independent-1",
  });
  return {
    nodes: [source, segment, claim, evidence],
    edges: [
      { id: "edge-1", from: "source-1", to: "segment-1", relation: "SOURCE_HAS_SEGMENT", createdAt: "2026-11-10T14:00:00.000Z" },
      { id: "edge-2", from: "segment-1", to: "claim-1", relation: "SEGMENT_SUPPORTS_CLAIM", createdAt: "2026-11-10T14:00:00.000Z" },
      { id: "edge-3", from: "evidence-1", to: "claim-1", relation: "EVIDENCE_SUPPORTS_CLAIM", createdAt: "2026-11-10T14:00:00.000Z" },
    ],
    metadata: { ontologyVersion: KRATT_ONTOLOGY_VERSION },
  };
}
function proposalFor(snapshot, rootDelta) {
  const payload = {
    schemaVersion: "kratt-telegram-reflection-proposal/v1",
    status: "PROPOSAL_ONLY", applyStatus: "NOT_APPLIED",
    decisionId: "decision-ontology", requestId: "request-ontology", claimId: "claim-1",
    targetDigest: digest("claim"), evidenceSnapshotDigest: digest("evidence"),
    policyVersion: "strict/v1", expectedRootVersion: snapshot.version,
    expectedRootDigest: snapshot.digest, rootDeltaDigest: digest(canonical(rootDelta)), rootDelta,
    createdFromVerifiedDecisionAt: "2026-11-10T14:00:00.000Z",
  };
  const proposalDigest = digest(canonical(payload));
  return { ...payload, proposalId: `reflection-proposal:${proposalDigest.slice(7)}`, proposalDigest };
}

test("accepts versioned source, segment, claim and evidence provenance graph", () => {
  assert.deepEqual(validateReflectionOntology(validDocument()), { ok: true, errors: [] });
});

test("rejects model claim promotion, missing provenance and invalid relation endpoints", () => {
  const promoted = validDocument();
  promoted.nodes[2] = node("claim-1", "CLAIM", {
    normalizedText: "A testable proposition", extractionMethod: "model", claimStatus: "APPROVED", sourceRefs: [{ segmentId: "segment-1" }],
  });
  assert.ok(validateReflectionOntology(promoted).errors.includes("ONTOLOGY_MODEL_CLAIM_PROMOTION_FORBIDDEN"));

  const broken = validDocument();
  broken.edges[0] = { ...broken.edges[0], to: "missing-segment" };
  assert.ok(validateReflectionOntology(broken).errors.includes("ONTOLOGY_EDGE_ENDPOINT_OR_RELATION_INVALID"));
});

test("rejects derivation and parent-child cycles", () => {
  const document = validDocument();
  document.edges.push(
    { id: "edge-4", from: "claim-1", to: "evidence-1", relation: "DERIVED_FROM", createdAt: "2026-11-10T14:00:00.000Z" },
    { id: "edge-5", from: "evidence-1", to: "claim-1", relation: "DERIVED_FROM", createdAt: "2026-11-10T14:00:00.000Z" },
  );
  assert.ok(validateReflectionOntology(document).errors.includes("ONTOLOGY_DERIVATION_CYCLE"));
});

test("ontology-validated root store fails closed on semantic promotion during CAS", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const initialSnapshot = createRootSnapshot(validDocument());
    const store = createOntologyValidatedReflectionRootStore(db, {
      initialSnapshot,
      verifyProposal: () => true,
      now: () => "2026-11-10T15:00:00.000Z",
    });
    const snapshot = store.getSnapshot().snapshot;
    const rootDelta = {
      schemaVersion: "kratt-root-delta/v1",
      operations: [{ op: "replace", path: "/nodes/2/attributes/claimStatus", value: "APPROVED" }],
    };
    const result = store.applyProposal(proposalFor(snapshot, rootDelta));
    assert.equal(result.status, "DENY");
    assert.equal(store.getSnapshot().snapshot.version, 0);
    assert.equal(store.getSnapshot().snapshot.document.nodes[2].attributes.claimStatus, "UNREVIEWED");
  } finally { db.close(); }
});

test("ontology-validated root factory rejects an unversioned initial root", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const invalid = validDocument();
    invalid.metadata.ontologyVersion = "unversioned";
    assert.throws(() => createOntologyValidatedReflectionRootStore(db, {
      initialSnapshot: createRootSnapshot(invalid), verifyProposal: () => true,
    }), /KRATT_ONTOLOGY_INITIAL_ROOT_INVALID/);
  } finally { db.close(); }
});


test("Telegram CAS composition requires a valid ontology root before accepting trusted adapters", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const adapter = createOntologyValidatedTelegramReflectionCasAdapter({
      database: db,
      initialSnapshot: createRootSnapshot(validDocument()),
      decisionStore: {
        getReviewRequest: () => null,
        getDecision: () => null,
      },
      verifyApprovalProof: () => false,
      now: () => Date.parse("2026-11-10T15:00:00.000Z"),
    });
    assert.equal(adapter.rootStore.getSnapshot().status, "OK");
    assert.equal(adapter.rootStore.getSnapshot().snapshot.document.metadata.ontologyVersion, KRATT_ONTOLOGY_VERSION);
  } finally { db.close(); }
});
