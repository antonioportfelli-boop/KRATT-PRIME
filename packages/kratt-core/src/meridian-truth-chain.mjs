import { canonicalJson, canonicalDigest } from "./canonical-json.mjs";
import { evaluateWordSemantics, validateWordSemanticRecord } from "./word-semantic-model.mjs";

const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const deepFreeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export function semanticOriginDigest(record) {
  return canonicalDigest({
    record_id: record.record_id,
    source: record.source,
    context_id: record.context_id,
    created_at: record.created_at,
    form: record.form,
    contents: record.contents
  });
}

function correction(recordId, code, action, severity, evidenceRefs = [], details = {}) {
  const core = {
    schema_version: "kratt-semantic-correction/v1",
    record_id: recordId,
    code,
    action,
    severity,
    evidence_refs: [...new Set(evidenceRefs)].sort(),
    details,
    auto_apply: false,
    requires_new_evidence_or_human_review: true
  };
  return Object.freeze({ proposal_id: "correction:" + canonicalDigest(core).slice("sha256:".length), ...core });
}

function reflectionReview(engine, reflection, required, record) {
  if (reflection == null) {
    return required
      ? { ok: false, status: "BLOCKED", reason: "MOTLEMINe_REFLECTION_REQUIRED" }
      : { ok: true, status: "NOT_RUN", report: null, bindingDigest: null };
  }
  if (!engine || typeof engine.analyze !== "function") {
    return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_ENGINE_NOT_CONFIGURED" };
  }
  try {
    canonicalJson(reflection);
  } catch {
    return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_REFLECTION_NOT_CANONICAL" };
  }
  if (!plain(reflection) || reflection.record_id !== record.record_id
      || reflection.source_digest !== record.source.source_digest
      || !Array.isArray(reflection.claims) || !Array.isArray(reflection.claim_bindings)
      || reflection.claims.length === 0 || reflection.claim_bindings.length !== reflection.claims.length
      || !Array.isArray(reflection.evidence) || reflection.evidence.length === 0
      || reflection.evidence.some(item => !plain(item) || item.subject !== record.record_id)) {
    return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_REFLECTION_NOT_BOUND_TO_RECORD" };
  }

  const contentById = new Map(record.contents.map(item => [item.content_id, item.payload]));
  const senseById = new Map(record.senses.map(item => [item.sense_id, item.definition]));
  const claimsById = new Map(reflection.claims.map(item => [item?.claim_id, item]));
  const mappedClaims = new Set();
  for (const binding of reflection.claim_bindings) {
    if (!plain(binding) || Reflect.ownKeys(binding).length !== 3
        || !Object.hasOwn(binding, "claim_id") || !Object.hasOwn(binding, "target_type")
        || !Object.hasOwn(binding, "target_id") || mappedClaims.has(binding.claim_id)) {
      return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_CLAIM_BINDING_INVALID" };
    }
    const claim = claimsById.get(binding.claim_id);
    const targetText = binding.target_type === "CONTENT" ? contentById.get(binding.target_id)
      : binding.target_type === "SENSE" ? senseById.get(binding.target_id) : undefined;
    if (!claim || typeof targetText !== "string" || claim.statement !== targetText) {
      return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_CLAIM_BINDING_MISMATCH" };
    }
    mappedClaims.add(binding.claim_id);
  }
  if (mappedClaims.size !== claimsById.size) {
    return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_CLAIM_BINDING_INCOMPLETE" };
  }

  try {
    const report = engine.analyze({
      analysis_id: reflection.analysis_id,
      claims: reflection.claims,
      evidence: reflection.evidence
    });
    if (!plain(report) || typeof report.status !== "string") {
      return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_REPORT_INVALID" };
    }
    const bindingDigest = canonicalDigest(reflection);
    if (report.status !== "READY_FOR_REVIEW") {
      return { ok: false, status: report.status, reason: "MOTLEMINe_REVIEW_NOT_CLEAR", report, bindingDigest };
    }
    return { ok: true, status: report.status, report, bindingDigest };
  } catch {
    return { ok: false, status: "BLOCKED", reason: "MOTLEMINe_ANALYSIS_FAILED" };
  }
}
function reflectionCorrections(recordId, report) {
  if (!report || !Array.isArray(report.claims)) return [];
  const proposals = [];
  for (const claim of report.claims) {
    if (claim.status === "SUPPORTED") continue;
    const mapping = {
      REFUTED: ["CLAIM_REFUTED_BY_VERIFIED_EVIDENCE", "REAUTHOR_CLAIM_FROM_EVIDENCE"],
      CONFLICTED: ["INDEPENDENT_EVIDENCE_CONFLICT", "RECONCILE_CONTRADICTORY_SOURCES"],
      INSUFFICIENT_EVIDENCE: ["INSUFFICIENT_INDEPENDENT_EVIDENCE", "GATHER_INDEPENDENT_CORROBORATION"],
      BLOCKED: ["DEPENDENCY_CHAIN_NOT_SUPPORTED", "REVIEW_DEPENDENCY_CHAIN"]
    };
    const [code, action] = mapping[claim.status] ?? ["REFLECTION_STATUS_UNRECOGNIZED", "REQUEST_HUMAN_REVIEW"];
    proposals.push(correction(
      recordId, code, action, "BLOCKING",
      [...(claim.support_evidence_ids ?? []), ...(claim.refute_evidence_ids ?? []), ...(claim.rejected_or_unverified_evidence_ids ?? [])],
      { claim_id: claim.claim_id, claim_status: claim.status, reason: claim.reason }
    ));
  }
  return proposals;
}

/**
 * Two-sided semantic integrity gate:
 * - Talmud preflight anchors the first extracted content in the actual source occurrence.
 * - Anti-Talmud postflight checks that origin after interpretation/classification,
 *   validates the final layers and optionally runs the MÕTLEMINE evidence-reflection report.
 *
 * It creates correction proposals only. It never edits source facts, writes memory,
 * grants authorization, or changes the KRATT policy decision.
 */
export function createMeridianTruthChain({
  reflectionEngine = null,
  requiredLayers = ["CONTENT", "SENSE"],
  requireReflection = false,
  clock = () => new Date().toISOString()
} = {}) {
  if (reflectionEngine !== null && typeof reflectionEngine.analyze !== "function") {
    throw new TypeError("MOTLEMINe_REFLECTION_ENGINE_INVALID");
  }
  if (!Array.isArray(requiredLayers) || requiredLayers.length === 0
      || requiredLayers.some(layer => !["CONTENT", "SENSE", "PRINCIPLE", "INTENT", "SPEECH_ACT", "EFFECT", "POWER", "AUTHORITY"].includes(layer))
      || new Set(requiredLayers).size !== requiredLayers.length) {
    throw new TypeError("MERIDIAN_REQUIRED_LAYERS_INVALID");
  }
  if (typeof requireReflection !== "boolean" || typeof clock !== "function") {
    throw new TypeError("MERIDIAN_TRUTH_CHAIN_CONFIG_INVALID");
  }

  function talmudPreflight({ record, reflection = null } = {}) {
    const checked = validateWordSemanticRecord(record);
    if (!checked.ok) {
      return Object.freeze({ ok: false, status: "BLOCKED", reason: checked.reason, correction_proposals: Object.freeze([]) });
    }
    const sourceId = checked.value.source.source_evidence_id;
    const sourceBound = checked.value.contents.some(content =>
      ["SOURCE", "QUOTED", "REPORTED", "TRANSLATED"].includes(content.attribution.kind)
      && content.evidence_refs.includes(sourceId));
    if (!sourceBound) {
      const proposal = correction(
        checked.value.record_id, "SOURCE_CONTENT_NOT_BOUND_TO_SOURCE_EVIDENCE",
        "RE_EXTRACT_CONTENT_FROM_ORIGINAL_SOURCE", "BLOCKING", [sourceId]
      );
      return Object.freeze({
        ok: false, status: "BLOCKED", reason: proposal.code,
        correction_proposals: Object.freeze([proposal])
      });
    }

    const reflected = reflectionReview(reflectionEngine, reflection, requireReflection, checked.value);
    if (!reflected.ok) {
      const proposals = reflectionCorrections(checked.value.record_id, reflected.report);
      if (!proposals.length) proposals.push(correction(
        checked.value.record_id, reflected.reason, "REVIEW_SOURCE_CLAIMS_AND_EVIDENCE", "BLOCKING",
        [sourceId]
      ));
      return Object.freeze({
        ok: false, status: "NEEDS_REVIEW", reason: reflected.reason,
        reflection_status: reflected.status,
        correction_proposals: Object.freeze(proposals)
      });
    }

    const originDigest = semanticOriginDigest(checked.value);
    const tokenCore = {
      schema_version: "meridian-preflight/v1",
      record_id: checked.value.record_id,
      origin_digest: originDigest,
      reflection_digest: reflected.bindingDigest ?? null
    };
    const token = deepFreeze({ ...tokenCore, token_digest: canonicalDigest(tokenCore) });
    return Object.freeze({
      ok: true,
      status: "PRECHECK_PASSED",
      token,
      report: Object.freeze({
        schema_version: "meridian-truth-chain/v1",
        stage: "TALMUD_PREFLIGHT",
        record_id: checked.value.record_id,
        origin_digest: originDigest,
        reflection_status: reflected.status,
        policy_authority: false,
        authorization_granted: false
      })
    });
  }

  function antiTalmudPostflight({ record, preflightToken, reflection = null } = {}) {
    const checked = validateWordSemanticRecord(record);
    if (!checked.ok) {
      return Object.freeze({
        ok: false, status: "BLOCKED", reason: checked.reason,
        correction_proposals: Object.freeze([])
      });
    }
    const token = preflightToken;
    const tokenCore = token && {
      schema_version: token.schema_version,
      record_id: token.record_id,
      origin_digest: token.origin_digest,
      reflection_digest: token.reflection_digest
    };
    let tokenCanonical = false;
    try { canonicalJson(token); tokenCanonical = true; } catch {}
    if (!plain(token) || !tokenCanonical || Reflect.ownKeys(token).length !== 5
        || token.schema_version !== "meridian-preflight/v1"
        || token.record_id !== checked.value.record_id
        || token.token_digest !== canonicalDigest(tokenCore)) {
      return Object.freeze({
        ok: false, status: "BLOCKED", reason: "MERIDIAN_PREFLIGHT_TOKEN_INVALID",
        correction_proposals: Object.freeze([])
      });
    }

    const actualOriginDigest = semanticOriginDigest(checked.value);
    if (actualOriginDigest !== token.origin_digest) {
      const proposal = correction(
        checked.value.record_id, "SOURCE_ORIGIN_MUTATED_AFTER_PREFLIGHT",
        "RE_EXTRACT_CONTENT_FROM_ORIGINAL_SOURCE", "BLOCKING",
        [checked.value.source.source_evidence_id],
        { expected_origin_digest: token.origin_digest, actual_origin_digest: actualOriginDigest }
      );
      return Object.freeze({
        ok: false, status: "BLOCKED", reason: proposal.code,
        correction_proposals: Object.freeze([proposal])
      });
    }

    let evaluatedAt;
    try { evaluatedAt = clock(); } catch {
      return Object.freeze({ ok: false, status: "BLOCKED", reason: "MERIDIAN_CLOCK_FAILED", correction_proposals: Object.freeze([]) });
    }
    const semantic = evaluateWordSemantics(checked.value, { now: evaluatedAt, requiredLayers });
    if (!semantic.ok) {
      return Object.freeze({ ok: false, status: "BLOCKED", reason: semantic.reason, correction_proposals: Object.freeze([]) });
    }

    const proposals = [];
    if (semantic.status === "AUTHORITY_CONFLICT") {
      proposals.push(correction(
        checked.value.record_id, "REVOKED_AUTHORITY_CONFLICT",
        "REVERIFY_OR_REVOKE_AUTHORITY_CLAIM", "BLOCKING",
        checked.value.authorities.flatMap(item => item.evidence_refs),
      ));
    }
    for (const layer of semantic.missing_layers) {
      proposals.push(correction(
        checked.value.record_id, "REQUIRED_SEMANTIC_LAYER_MISSING",
        "COMPLETE_LAYER_FROM_SOURCE_AND_EVIDENCE", "BLOCKING",
        [checked.value.source.source_evidence_id], { layer }
      ));
    }
    if (semantic.ambiguous_sense_ids.length) {
      proposals.push(correction(
        checked.value.record_id, "CONTEXTUAL_SENSE_AMBIGUITY",
        "DISAMBIGUATE_SENSES_WITH_CONTEXT", "BLOCKING",
        checked.value.senses.flatMap(item => item.evidence_refs),
        { sense_ids: semantic.ambiguous_sense_ids }
      ));
    }
    if (semantic.effects_without_causal_establishment.length) {
      proposals.push(correction(
        checked.value.record_id, "EFFECT_CAUSALITY_NOT_ESTABLISHED",
        "KEEP_EFFECT_AS_ASSERTION_OR_ADD_CAUSAL_MEASUREMENT", "ADVISORY",
        checked.value.effects.flatMap(item => item.evidence_refs),
        { effect_ids: semantic.effects_without_causal_establishment }
      ));
    }

    const reflected = reflectionReview(reflectionEngine, reflection, requireReflection);
    if (!reflected.ok) {
      const generated = reflectionCorrections(checked.value.record_id, reflected.report);
      proposals.push(...generated);
      if (!generated.length) proposals.push(correction(
        checked.value.record_id, reflected.reason,
        "REVIEW_CLAIMS_WITH_INDEPENDENT_EVIDENCE", "BLOCKING",
        [checked.value.source.source_evidence_id]
      ));
    }

    const blocking = proposals.some(item => item.severity === "BLOCKING");
    const reportCore = {
      schema_version: "meridian-truth-chain/v1",
      stage: "ANTI_TALMUD_POSTFLIGHT",
      status: blocking ? "REVIEW_REQUIRED" : "CLEAR_FOR_POLICY_GATE",
      record_id: checked.value.record_id,
      origin_digest: actualOriginDigest,
      record_digest: canonicalDigest(checked.value),
      semantic_status: semantic.status,
      reflection_status: reflected.status,
      reflection_digest: reflected.bindingDigest ?? null,
      reflection_report_digest: reflected.report?.report_digest ?? null,
      correction_proposals: proposals,
      auto_corrections_applied: 0,
      policy_authority: false,
      authorization_granted: false
    };
    const report = deepFreeze({ ...reportCore, truth_chain_digest: canonicalDigest(reportCore) });
    return Object.freeze({
      ok: !blocking,
      status: report.status,
      reason: blocking ? "MERIDIAN_REVIEW_REQUIRED" : "MERIDIAN_TRUTH_CHAIN_CLEAR",
      correction_proposals: report.correction_proposals,
      report
    });
  }

  return Object.freeze({ talmudPreflight, antiTalmudPostflight });
}
