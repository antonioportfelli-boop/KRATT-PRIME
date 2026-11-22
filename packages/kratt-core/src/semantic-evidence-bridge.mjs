import { createHash } from "node:crypto";
import { validateEvidenceRecord } from "./contracts.mjs";
import { MemoryLedger } from "./memory-ledger.mjs";
import { evaluateWordSemantics, validateWordSemanticRecord } from "./word-semantic-model.mjs";

export const SEMANTIC_EVIDENCE_BRIDGE_VERSION = "1.0.0";
export const SEMANTIC_MEMORY_KIND = "WORD_SEMANTIC_RECORD";

const bad = reason => Object.freeze({ ok: false, reason });
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
};
const canonical = value => JSON.stringify(stable(value));
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const digest = value => "sha256:" + sha256(canonical(value));


function createProvenanceGraph(record, verifiedEvidence) {
  const nodes = [];
  const edges = [];
  const ids = new Set();
  const sourceId = "source:" + record.record_id;

  function addNode(id, type, data, evidenceIds = [], confidence = null, attribution = null) {
    if (ids.has(id)) throw new Error("SEMANTIC_GRAPH_NODE_COLLISION");
    ids.add(id);
    nodes.push({
      id, type, data: structuredClone(data),
      evidence_ids: [...new Set(evidenceIds)].sort(),
      confidence,
      attribution: attribution ? structuredClone(attribution) : null
    });
  }
  function addEdge(from, to, relation, evidenceIds = [], confidence = null) {
    if (!ids.has(from) || !ids.has(to)) throw new Error("SEMANTIC_GRAPH_DANGLING_EDGE");
    const core = {
      from, to, relation,
      evidence_ids: [...new Set(evidenceIds)].sort(),
      confidence
    };
    const id = "edge:" + sha256(canonical(core));
    if (!edges.some(edge => edge.id === id)) edges.push({ id, ...core });
  }

  addNode(sourceId, "SOURCE_OCCURRENCE", {
    source_ref: record.source.source_ref,
    source_digest: record.source.source_digest,
    source_evidence_id: record.source.source_evidence_id,
    context_id: record.context_id,
    created_at: record.created_at
  }, [record.source.source_evidence_id], 1, { kind: "SOURCE", actor_ref: null });
  addNode("form:" + record.form.token_id, "FORM", record.form,
    [record.source.source_evidence_id], 1, { kind: "SOURCE", actor_ref: null });

  for (const item of record.contents) {
    addNode("content:" + item.content_id, "CONTENT", item, item.evidence_refs,
      item.confidence, item.attribution);
  }
  for (const item of record.senses) {
    addNode("sense:" + item.sense_id, "SENSE", item, item.evidence_refs,
      item.confidence, { kind: "INTERPRETATION", actor_ref: null });
  }
  for (const item of record.principles) {
    addNode("principle:" + item.principle_id, "PRINCIPLE", item,
      item.source_refs, null, { kind: "NORMATIVE_SOURCE", actor_ref: null });
  }
  for (const item of record.intents) {
    addNode("intent:" + item.intent_id, "INTENT", item, item.evidence_refs,
      item.confidence, { kind: item.attribution_kind, actor_ref: item.actor_ref });
  }
  for (const item of record.speech_acts) {
    addNode("speech-act:" + item.act_id, "SPEECH_ACT", item, item.evidence_refs,
      null, { kind: "CONTEXTUAL_ACT", actor_ref: item.speaker_ref });
  }
  for (const item of record.effects) {
    addNode("effect:" + item.effect_id, "EFFECT", item,
      [...item.evidence_refs, ...item.measurement_refs], null,
      { kind: "EFFECT_CLAIM", actor_ref: null });
  }
  for (const item of record.powers) {
    addNode("power:" + item.power_id, "POWER", item, item.evidence_refs,
      null, { kind: "POWER_DESCRIPTION", actor_ref: item.holder_ref });
  }
  for (const item of record.authorities) {
    addNode("authority:" + item.authority_id, "AUTHORITY_CLAIM", item,
      item.evidence_refs, null, { kind: "AUTHORITY_CLAIM", actor_ref: item.issuer_ref });
  }

  for (const [evidenceId, item] of verifiedEvidence) {
    addNode("evidence:" + evidenceId, "EVIDENCE", {
      evidence_id: item.evidence_id,
      subject: item.subject,
      claim_type: item.claim_type,
      source: item.source,
      observed_at: item.observed_at,
      verification_method: item.verification_method,
      artifact_digest: item.artifact_digest
    }, [evidenceId]);
  }

  addEdge(sourceId, "form:" + record.form.token_id, "HAS_FORM",
    [record.source.source_evidence_id], 1);
  for (const item of record.contents) {
    addEdge(sourceId, "content:" + item.content_id, "HAS_CONTENT",
      item.evidence_refs, item.confidence);
  }
  for (const item of record.senses) {
    for (const contentId of item.content_refs) {
      addEdge("content:" + contentId, "sense:" + item.sense_id, "INTERPRETED_AS",
        item.evidence_refs, item.confidence);
    }
  }
  for (const item of record.principles) {
    addEdge(sourceId, "principle:" + item.principle_id, "CARRIES_PRINCIPLE", item.source_refs);
  }
  for (const item of record.intents) {
    addEdge(sourceId, "intent:" + item.intent_id, "ATTRIBUTED_INTENT",
      item.evidence_refs, item.confidence);
  }
  for (const item of record.speech_acts) {
    const id = "speech-act:" + item.act_id;
    addEdge(sourceId, id, "PERFORMS_SPEECH_ACT", item.evidence_refs);
    for (const contentId of item.content_refs) {
      addEdge(id, "content:" + contentId, "ACTS_ON_CONTENT", item.evidence_refs);
    }
  }
  for (const item of record.effects) {
    const id = "effect:" + item.effect_id;
    addEdge(sourceId, id, "HAS_EFFECT_CLAIM", item.evidence_refs);
    for (const measurementId of item.measurement_refs) {
      addEdge(id, "evidence:" + measurementId, "MEASURED_BY", [measurementId]);
    }
  }
  for (const item of record.powers) {
    addEdge(sourceId, "power:" + item.power_id, "HAS_POWER_RELATION", item.evidence_refs);
  }
  for (const item of record.authorities) {
    addEdge(sourceId, "authority:" + item.authority_id, "HAS_AUTHORITY_CLAIM", item.evidence_refs);
  }
  for (const node of [...nodes]) {
    for (const evidenceId of node.evidence_ids) {
      addEdge(node.id, "evidence:" + evidenceId, "SUPPORTED_BY", [evidenceId], node.confidence);
    }
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  const core = {
    schema_version: "kratt-semantic-provenance-graph/v1",
    source_record_id: record.record_id,
    nodes,
    edges
  };
  return Object.freeze({ ...core, graph_digest: digest(core) });
}

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
      ...semantic.authorities.map(authority => authority.evidence_refs)
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
    const evidenceManifestDigest = digest(evidenceManifest);
    const recordDigest = digest(semantic);
    const provenanceGraph = createProvenanceGraph(semantic, verified);
    const existing = ledger.list({ kind: SEMANTIC_MEMORY_KIND })
      .find(entry => entry.record?.payload?.record_id === semantic.record_id);
    if (existing) {
      if (existing.record.payload.record_digest !== recordDigest
          || existing.record.payload.evidence_manifest_digest !== evidenceManifestDigest) {
        return bad("SEMANTIC_RECORD_ID_COLLISION");
      }
      return Object.freeze({
        ok: true,
        duplicate: true,
        memoryId: existing.record.id,
        memoryHash: existing.hash,
        graphDigest: existing.record.payload.provenance_graph.graph_digest,
        semanticStatus: existing.record.payload.semantic_status,
        authorizationGranted: false,
        policyAuthority: false,
        durable: false
      });
    }

    const memoryRecord = {
      id: "word-semantic:" + semantic.record_id,
      kind: SEMANTIC_MEMORY_KIND,
      createdAt: semantic.created_at,
      payload: {
        schema_version: "kratt-semantic-memory/v1",
        record_id: semantic.record_id,
        record_digest: recordDigest,
        evidence_manifest_digest: evidenceManifestDigest,
        semantic_status: semanticEvaluation.status,
        semantic_record: semantic,
        source_evidence_id: semantic.source.source_evidence_id,
        evidence_ids: evidenceIds,
        evidence_manifest: evidenceManifest,
        provenance_graph: provenanceGraph,
        authorization_granted: false,
        policy_authority: false
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
      graphDigest: provenanceGraph.graph_digest,
      nodeCount: provenanceGraph.nodes.length,
      edgeCount: provenanceGraph.edges.length,
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
