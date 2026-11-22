import { validateWordSemanticRecord } from "../../kratt-core/src/word-semantic-model.mjs";
import { semanticOriginDigest, createMeridianTruthChain } from "../../kratt-core/src/meridian-truth-chain.mjs";

const bad = (status, reason, details = {}) => Object.freeze({ ok: false, status, reason, ...details });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function requireAgent(agent, name) {
  if (typeof agent !== "function") throw new TypeError("SEMANTIC_AGENT_REQUIRED:" + name);
  return agent;
}

/**
 * Staged semantic agent pipeline.
 * Talmud preflight anchors source-grounded content before interpretation.
 * Anti-Talmud postflight checks the final record and optional MÕTLEMINE reflection
 * before the separate policy-gated ingestion runtime is invoked.
 */
export function createSemanticAgentPipeline({
  extractSource, contextualize, classifySemantics, review, ingestion, onStage = () => {},
  truthChain = null, reflectionEngine = null, requiredLayers = ["CONTENT", "SENSE"],
  requireReflection = false
} = {}) {
  const extract = requireAgent(extractSource, "EXTRACT_SOURCE");
  const contextualizeAgent = requireAgent(contextualize, "CONTEXTUALIZE");
  const classify = requireAgent(classifySemantics, "CLASSIFY_SEMANTICS");
  const critic = requireAgent(review, "REVIEW");
  if (!ingestion || typeof ingestion.ingest !== "function") throw new TypeError("SEMANTIC_INGESTION_RUNTIME_REQUIRED");
  if (typeof onStage !== "function") throw new TypeError("SEMANTIC_STAGE_SINK_REQUIRED");
  const integrity = truthChain ?? createMeridianTruthChain({ reflectionEngine, requiredLayers, requireReflection });
  if (!integrity || typeof integrity.talmudPreflight !== "function"
      || typeof integrity.antiTalmudPostflight !== "function") {
    throw new TypeError("SEMANTIC_TRUTH_CHAIN_REQUIRED");
  }

  async function auditGuard(stageName, status, recordId) {
    try {
      await onStage(Object.freeze({ stage: stageName, status, recordId }));
      return true;
    } catch {
      return false;
    }
  }

  async function stage(name, fn, input) {
    let result;
    try { result = await fn(input); }
    catch { return bad("BLOCKED", "SEMANTIC_AGENT_STAGE_FAILED:" + name); }
    if (!plain(result) || result.ok === false) return bad("BLOCKED", "SEMANTIC_AGENT_STAGE_REJECTED:" + name);
    try { await onStage(Object.freeze({ stage: name, status: "COMPLETED", recordId: input?.record?.record_id ?? null })); }
    catch { return bad("BLOCKED", "SEMANTIC_STAGE_AUDIT_FAILED:" + name); }
    return { ok: true, value: result.record ?? result };
  }

  async function run({
    requestId, principalId, source, context, approval,
    preflightReflection = null, postflightReflection = null
  } = {}) {
    if (typeof requestId !== "string" || typeof principalId !== "string" || !plain(source) || !plain(context)) {
      return bad("BLOCKED", "SEMANTIC_PIPELINE_INPUT_INVALID");
    }

    const extracted = await stage("EXTRACT_SOURCE", extract, {
      requestId, principalId, source: structuredClone(source), context: structuredClone(context)
    });
    if (!extracted.ok) return extracted;
    let checked = validateWordSemanticRecord(extracted.value);
    if (!checked.ok) return bad("BLOCKED", "SEMANTIC_RECORD_INVALID_AFTER_EXTRACTION:" + checked.reason);
    let record = checked.value;

    let preflight;
    try { preflight = integrity.talmudPreflight({ record, reflection: preflightReflection }); }
    catch { return bad("BLOCKED", "TALMUD_PREFLIGHT_FAILED"); }
    if (!plain(preflight) || preflight.ok !== true || !preflight.token) {
      const audited = await auditGuard("TALMUD_PREFLIGHT", preflight?.status ?? "BLOCKED", record.record_id);
      if (!audited) return bad("BLOCKED", "SEMANTIC_STAGE_AUDIT_FAILED:TALMUD_PREFLIGHT");
      return bad(preflight?.status === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "BLOCKED",
        preflight?.reason ?? "TALMUD_PREFLIGHT_REJECTED",
        { correctionProposals: preflight?.correction_proposals ?? [] });
    }
    if (!await auditGuard("TALMUD_PREFLIGHT", "PRECHECK_PASSED", record.record_id)) {
      return bad("BLOCKED", "SEMANTIC_STAGE_AUDIT_FAILED:TALMUD_PREFLIGHT");
    }
    const origin = preflight.token.origin_digest;

    const contextualized = await stage("CONTEXTUALIZE", contextualizeAgent, {
      requestId, principalId, source: structuredClone(source), context: structuredClone(context), record: structuredClone(record)
    });
    if (!contextualized.ok) return contextualized;
    checked = validateWordSemanticRecord(contextualized.value);
    if (!checked.ok) return bad("BLOCKED", "SEMANTIC_RECORD_INVALID_AFTER_CONTEXTUALIZATION:" + checked.reason);
    if (semanticOriginDigest(checked.value) !== origin) {
      return bad("BLOCKED", "SEMANTIC_ORIGIN_MUTATED_AFTER_EXTRACTION");
    }
    record = checked.value;

    const classified = await stage("CLASSIFY_SEMANTICS", classify, {
      requestId, principalId, source: structuredClone(source), context: structuredClone(context), record: structuredClone(record)
    });
    if (!classified.ok) return classified;
    checked = validateWordSemanticRecord(classified.value);
    if (!checked.ok) return bad("BLOCKED", "SEMANTIC_RECORD_INVALID_AFTER_CLASSIFICATION:" + checked.reason);
    if (semanticOriginDigest(checked.value) !== origin) {
      return bad("BLOCKED", "SEMANTIC_ORIGIN_MUTATED_AFTER_CLASSIFICATION");
    }
    record = checked.value;

    const reviewed = await stage("CRITIC_REVIEW", critic, {
      requestId, principalId, source: structuredClone(source), context: structuredClone(context), record: structuredClone(record)
    });
    if (!reviewed.ok) return reviewed;
    const verdict = reviewed.value.verdict ?? reviewed.value.decision;
    if (verdict !== "ACCEPT") {
      return bad(verdict === "REVISE" ? "NEEDS_REVIEW" : "BLOCKED", "SEMANTIC_CRITIC_DID_NOT_ACCEPT", {
        verdict: typeof verdict === "string" ? verdict : "MISSING",
        issues: Array.isArray(reviewed.value.issues) ? reviewed.value.issues : []
      });
    }

    let postflight;
    try {
      postflight = integrity.antiTalmudPostflight({
        record, preflightToken: preflight.token, reflection: postflightReflection
      });
    } catch {
      return bad("BLOCKED", "ANTI_TALMUD_POSTFLIGHT_FAILED");
    }
    if (!plain(postflight) || postflight.ok !== true || postflight.status !== "CLEAR_FOR_POLICY_GATE") {
      const audited = await auditGuard("ANTI_TALMUD_POSTFLIGHT", postflight?.status ?? "BLOCKED", record.record_id);
      if (!audited) return bad("BLOCKED", "SEMANTIC_STAGE_AUDIT_FAILED:ANTI_TALMUD_POSTFLIGHT");
      return bad(postflight?.status === "REVIEW_REQUIRED" ? "NEEDS_REVIEW" : "BLOCKED",
        postflight?.reason ?? "ANTI_TALMUD_POSTFLIGHT_REJECTED",
        {
          correctionProposals: postflight?.correction_proposals ?? [],
          truthChainReport: postflight?.report ?? null
        });
    }
    if (!await auditGuard("ANTI_TALMUD_POSTFLIGHT", "CLEAR_FOR_POLICY_GATE", record.record_id)) {
      return bad("BLOCKED", "SEMANTIC_STAGE_AUDIT_FAILED:ANTI_TALMUD_POSTFLIGHT");
    }

    try {
      const result = await ingestion.ingest({ requestId, principalId, record, approval });
      return plain(result) ? Object.freeze({ ...result, truthChain: postflight.report }) : result;
    } catch {
      return bad("BLOCKED", "SEMANTIC_INGESTION_RUNTIME_FAILED");
    }
  }

  return Object.freeze({ run });
}
