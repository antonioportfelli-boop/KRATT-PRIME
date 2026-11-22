import { createHash } from "node:crypto";
import { validateWordSemanticRecord } from "./word-semantic-model.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ACTION = "semantic.memory.append";
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bad = (status, reason) => Object.freeze({ ok: false, status, reason });
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

function collectEvidenceIds(record) {
  const ids = new Set([record.source.source_evidence_id]);
  const groups = [
    ...record.contents.map(item => item.evidence_refs),
    ...record.senses.map(item => item.evidence_refs),
    ...record.principles.map(item => item.source_refs),
    ...record.intents.map(item => item.evidence_refs),
    ...record.speech_acts.map(item => item.evidence_refs),
    ...record.effects.flatMap(item => [...item.evidence_refs, ...item.measurement_refs]),
    ...record.powers.map(item => item.evidence_refs),
    ...record.authorities.map(item => item.evidence_refs)
  ];
  for (const group of groups) for (const id of group) ids.add(id);
  return [...ids].sort();
}

/**
 * Policy-gated composition root for local semantic-memory ingestion.
 *
 * authorize() is a trusted adapter contract: in production it must evaluate the
 * existing KRATT policy/WP-01 path and return a decision bound to the exact request,
 * principal, action, resource and content digest. It must not infer ALLOW from
 * semantic content or a caller-supplied boolean.
 *
 * This runtime does not dispatch providers or authorize arbitrary external writes.
 * The evidence bridge independently verifies each cited evidence record.
 */
export function createSemanticIngestionRuntime({ authorize, loadEvidence, bridge } = {}) {
  if (typeof authorize !== "function") throw new TypeError("SEMANTIC_POLICY_AUTHORIZER_REQUIRED");
  if (typeof loadEvidence !== "function") throw new TypeError("SEMANTIC_EVIDENCE_LOADER_REQUIRED");
  if (!bridge || typeof bridge.ingest !== "function") throw new TypeError("SEMANTIC_EVIDENCE_BRIDGE_REQUIRED");

  async function ingest({ requestId, principalId, record, approval } = {}) {
    if (!ID.test(requestId ?? "") || !ID.test(principalId ?? "")) {
      return bad("BLOCKED", "SEMANTIC_REQUEST_IDENTITY_INVALID");
    }

    const checked = validateWordSemanticRecord(record);
    if (!checked.ok) return bad("BLOCKED", checked.reason);

    // Work on an isolated snapshot: policy and evidence checks must refer to
    // exactly the record that will be sent to the evidence bridge.
    const snapshot = structuredClone(checked.value);
    const recordDigest = "sha256:" + sha256(JSON.stringify(snapshot));
    const resource = "semantic-record:" + snapshot.record_id;
    const evidenceIds = collectEvidenceIds(snapshot);
    const request = Object.freeze({
      action: ACTION,
      requestId,
      principalId,
      resource,
      recordId: snapshot.record_id,
      recordDigest,
      sourceEvidenceId: snapshot.source.source_evidence_id,
      evidenceIds: Object.freeze(evidenceIds),
      approval: approval ?? null
    });

    let decision;
    try {
      decision = await authorize(request);
    } catch {
      return bad("BLOCKED", "SEMANTIC_POLICY_EVALUATION_FAILED");
    }

    if (!plain(decision) || decision.request_id !== requestId
        || decision.principal_id !== principalId || decision.action !== ACTION
        || decision.resource !== resource || decision.record_digest !== recordDigest
        || !ID.test(decision.decision_id ?? "")) {
      return bad("BLOCKED", "SEMANTIC_DECISION_NOT_REQUEST_BOUND");
    }

    if (decision.decision === "REQUIRE_APPROVAL") {
      return Object.freeze({
        ok: false,
        status: "WAITING_APPROVAL",
        reason: "SEMANTIC_MEMORY_APPROVAL_REQUIRED",
        decisionId: decision.decision_id,
        requestId,
        recordDigest
      });
    }
    if (decision.decision !== "ALLOW") {
      return Object.freeze({
        ok: false,
        status: decision.decision === "DENY" ? "DENIED" : "BLOCKED",
        reason: typeof decision.reason === "string"
          ? decision.reason
          : "SEMANTIC_MEMORY_POLICY_NOT_ALLOW",
        decisionId: decision.decision_id,
        requestId,
        recordDigest
      });
    }

    let evidence;
    try {
      evidence = await loadEvidence({
        requestId,
        principalId,
        recordId: snapshot.record_id,
        evidenceIds: Object.freeze(evidenceIds)
      });
    } catch {
      return bad("BLOCKED", "SEMANTIC_EVIDENCE_UNAVAILABLE");
    }
    if (!Array.isArray(evidence)) {
      return bad("BLOCKED", "SEMANTIC_EVIDENCE_ENVELOPE_INVALID");
    }

    let stored;
    try {
      stored = await bridge.ingest({ record: snapshot, evidence });
    } catch {
      return bad("BLOCKED", "SEMANTIC_MEMORY_INGEST_FAILED");
    }
    if (!plain(stored) || stored.ok !== true) {
      return bad("BLOCKED", typeof stored?.reason === "string"
        ? stored.reason
        : "SEMANTIC_MEMORY_INGEST_FAILED");
    }

    return Object.freeze({
      ok: true,
      status: stored.duplicate ? "DUPLICATE" : "STORED",
      requestId,
      decisionId: decision.decision_id,
      recordId: snapshot.record_id,
      recordDigest,
      memoryId: stored.memoryId,
      memoryHash: stored.memoryHash,
      graphDigest: stored.graphDigest ?? null,
      semanticStatus: stored.semanticStatus,
      evidenceIds: Object.freeze(evidenceIds),
      writeAuthorized: true,
      authorizationScope: ACTION,
      policyAuthority: false,
      semanticAuthority: false,
      externalWritesStarted: false,
      durable: stored.durable === true
    });
  }

  return Object.freeze({ ingest });
}
