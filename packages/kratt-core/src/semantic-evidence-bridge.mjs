import { createHash } from "node:crypto";
import { validateEvidenceRecord } from "./contracts.mjs";
import { MemoryLedger } from "./memory-ledger.mjs";
import { evaluateWordSemantics, validateWordSemanticRecord } from "./word-semantic-model.mjs";

export const SEMANTIC_EVIDENCE_BRIDGE_VERSION = "1.0.0";
export const SEMANTIC_MEMORY_KIND = "WORD_SEMANTIC_RECORD";

const bad = reason => Object.freeze({ ok: false, reason });
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Bridges source-bound Semantic Model v2 records into the append-only local MemoryLedger.
 * It is not a durable adapter and never grants policy or execution authority.
 */
export function createSemanticEvidenceBridge({ ledger, verifyEvidence } = {}) {
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.list !== "function"
      || typeof ledger.verify !== "function") throw new TypeError("MEMORY_LEDGER_ADAPTER_REQUIRED");
  if (typeof verifyEvidence !== "function") throw new TypeError("TRUSTED_EVIDENCE_VERIFIER_REQUIRED");

  async function ingest({ record, evidence } = {}) {
    const checkedRecord = validateWordSemanticRecord(record);
    if (!checkedRecord.ok) return checkedRecord;
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 256) {
      return bad("SEMANTIC_EVIDENCE_ENVELOPE_INVALID");
    }

    const evidenceById = new Map();
    for (const raw of evidence) {
      const checked = validateEvidenceRecord(raw);
      if (!checked.ok || evidenceById.has(checked.value.evidence_id)) {
        return bad("SEMANTIC_EVIDENCE_INVALID_OR_DUPLICATE");
      }
      evidenceById.set(checked.value.evidence_id, checked.value);
    }

    const semantic = structuredClone(checkedRecord.value);
    const sourceEvidence = evidenceById.get(semantic.source.source_evidence_id);
    if (!sourceEvidence) return bad("SOURCE_EVIDENCE_REFERENCE_MISSING");
    const expectedSourceRef = sourceEvidence.source.source_type + ":" + sourceEvidence.source.source_id;
    if (semantic.source.source_ref !== expectedSourceRef) return bad("SOURCE_EVIDENCE_REFERENCE_MISMATCH");
    if (sourceEvidence.artifact_digest !== "sha256:" + semantic.source.source_digest) {
      return bad("SOURCE_EVIDENCE_DIGEST_MISMATCH");
    }

    const requiredGroups = [
      ...semantic.contents.map(content => content.evidence_refs),
      ...semantic.senses.map(sense => sense.evidence_refs),
      ...semantic.intents.map(intent => intent.evidence_refs),
      ...semantic.speech_acts.map(act => act.evidence_refs),
      ...semantic.effects.map(effect => effect.evidence_refs),
      ...semantic.principles.map(principle => principle.source_refs),
      ...semantic.powers.map(power => power.evidence_refs),
      ...semantic.authorities.filter(authority => authority.status === "VERIFIED").map(authority => authority.evidence_refs)
    ];
    if (requiredGroups.some(refs => !Array.isArray(refs) || refs.length === 0)) {
      return bad("SEMANTIC_LAYER_PROVENANCE_REQUIRED");
    }

    const referenced = new Set([semantic.source.source_evidence_id]);
    for (const refs of requiredGroups) for (const evidenceId of refs) referenced.add(evidenceId);
    for (const effect of semantic.effects) {
      for (const evidenceId of effect.measurement_refs) referenced.add(evidenceId);
      if (["OBSERVED", "CAUSALLY_SUPPORTED", "CAUSALLY_ESTABLISHED"].includes(effect.causal_status)
          && effect.measurement_refs.length === 0) return bad("EFFECT_MEASUREMENT_EVIDENCE_REQUIRED");
    }

    const verified = new Map();
    for (const evidenceId of referenced) {
      const item = evidenceById.get(evidenceId);
      if (!item) return bad("SEMANTIC_EVIDENCE_REFERENCE_MISSING:" + evidenceId);
      if (item.result !== "VERIFIED") return bad("SEMANTIC_EVIDENCE_NOT_VERIFIED:" + evidenceId);
      let accepted = false;
      try {
        accepted = await verifyEvidence(item, Object.freeze({
          purpose: "word_semantic_memory_ingest",
          recordId: semantic.record_id,
          evidenceId
        })) === true;
      } catch {
        accepted = false;
      }
      if (!accepted) return bad("SEMANTIC_EVIDENCE_TRUST_CHECK_FAILED:" + evidenceId);
      verified.set(evidenceId, item);
    }

    const integrityBefore = ledger.verify();
    if (!integrityBefore?.ok) return bad("MEMORY_LEDGER_INTEGRITY_FAILED");

    const semanticEvaluation = evaluateWordSemantics(semantic);
    if (!semanticEvaluation.ok) return semanticEvaluation;

    const evidenceIds = [...verified.keys()].sort();
    const recordDigest = sha256(JSON.stringify(semantic));
    const existing = ledger.list({ kind: SEMANTIC_MEMORY_KIND })
      .find(entry => entry.record?.payload?.record_id === semantic.record_id);
    if (existing) {
      if (existing.record.payload.record_digest !== recordDigest
          || JSON.stringify(existing.record.payload.evidence_ids) !== JSON.stringify(evidenceIds)) {
        return bad("SEMANTIC_RECORD_ID_COLLISION");
      }
      return Object.freeze({
        ok: true,
        duplicate: true,
        memoryId: existing.record.id,
        memoryHash: existing.hash,
        semanticStatus: existing.record.payload.semantic_status,
        authorizationGranted: false,
        policyAuthority: false,
        durable: false
      });
    }

    const evidenceManifest = evidenceIds.map(evidenceId => {
      const item = verified.get(evidenceId);
      return Object.freeze({
        evidence_id: item.evidence_id,
        subject: item.subject,
        claim_type: item.claim_type,
        source: structuredClone(item.source),
        observed_at: item.observed_at,
        verification_method: item.verification_method,
        artifact_digest: item.artifact_digest
      });
    });

    const memoryRecord = {
      id: "word-semantic:" + semantic.record_id,
      kind: SEMANTIC_MEMORY_KIND,
      createdAt: semantic.created_at,
      payload: {
        schema_version: "kratt-semantic-memory/v1",
        record_id: semantic.record_id,
        record_digest: recordDigest,
        semantic_status: semanticEvaluation.status,
        semantic_record: semantic,
        source_evidence_id: semantic.source.source_evidence_id,
        evidence_ids: evidenceIds,
        evidence_manifest: evidenceManifest
      }
    };
    const appended = ledger.append(memoryRecord);
    if (!appended?.ok) return bad(appended?.reason ?? "SEMANTIC_MEMORY_APPEND_FAILED");
    const integrityAfter = ledger.verify();
    if (!integrityAfter?.ok) return bad("MEMORY_LEDGER_INTEGRITY_FAILED_AFTER_APPEND");

    return Object.freeze({
      ok: true,
      duplicate: false,
      memoryId: appended.entry.record.id,
      memorySequence: appended.entry.sequence,
      memoryHash: appended.entry.hash,
      recordDigest,
      semanticStatus: semanticEvaluation.status,
      evidenceIds: Object.freeze(evidenceIds),
      authorizationGranted: false,
      policyAuthority: false,
      durable: false
    });
  }

  return Object.freeze({ ingest });
}

export function createLocalSemanticEvidenceBridge({ verifyEvidence } = {}) {
  return createSemanticEvidenceBridge({ ledger: new MemoryLedger(), verifyEvidence });
}
