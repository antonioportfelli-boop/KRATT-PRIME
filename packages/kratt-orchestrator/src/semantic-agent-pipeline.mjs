import { validateWordSemanticRecord } from "../../kratt-core/src/word-semantic-model.mjs";

const bad = (status, reason, details = {}) => Object.freeze({ ok: false, status, reason, ...details });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function requireAgent(agent, name) {
  if (typeof agent !== "function") throw new TypeError("SEMANTIC_AGENT_REQUIRED:" + name);
  return agent;
}

/**
 * Staged semantic agent pipeline. Agents can extract, contextualize, classify and
 * critique; only the policy-gated ingestion runtime may append memory. No provider
 * dispatch or external side effect is exposed by this pipeline.
 */
export function createSemanticAgentPipeline({
  extractSource, contextualize, classifySemantics, review, ingestion, onStage = () => {}
} = {}) {
  const extract = requireAgent(extractSource, "EXTRACT_SOURCE");
  const contextualizeAgent = requireAgent(contextualize, "CONTEXTUALIZE");
  const classify = requireAgent(classifySemantics, "CLASSIFY_SEMANTICS");
  const critic = requireAgent(review, "REVIEW");
  if (!ingestion || typeof ingestion.ingest !== "function") throw new TypeError("SEMANTIC_INGESTION_RUNTIME_REQUIRED");
  if (typeof onStage !== "function") throw new TypeError("SEMANTIC_STAGE_SINK_REQUIRED");

  async function stage(name, fn, input) {
    let result;
    try { result = await fn(input); }
    catch { return bad("BLOCKED", "SEMANTIC_AGENT_STAGE_FAILED:" + name); }
    if (!plain(result) || result.ok === false) return bad("BLOCKED", "SEMANTIC_AGENT_STAGE_REJECTED:" + name);
    try { await onStage(Object.freeze({ stage: name, status: "COMPLETED", recordId: input?.record?.record_id ?? null })); }
    catch { return bad("BLOCKED", "SEMANTIC_STAGE_AUDIT_FAILED:" + name); }
    return { ok: true, value: result.record ?? result };
  }

  async function run({ requestId, principalId, source, context, approval } = {}) {
    if (typeof requestId !== "string" || typeof principalId !== "string" || !plain(source) || !plain(context)) {
      return bad("BLOCKED", "SEMANTIC_PIPELINE_INPUT_INVALID");
    }
    const extracted = await stage("EXTRACT_SOURCE", extract, { requestId, principalId, source: structuredClone(source), context: structuredClone(context) });
    if (!extracted.ok) return extracted;
    let record = extracted.value;
    let checked = validateWordSemanticRecord(record);
    if (!checked.ok) return bad("BLOCKED", "SEMANTIC_RECORD_INVALID_AFTER_EXTRACTION:" + checked.reason);
    record = checked.value;

    const contextualized = await stage("CONTEXTUALIZE", contextualizeAgent, { requestId, principalId, source, context, record });
    if (!contextualized.ok) return contextualized;
    record = contextualized.value;
    checked = validateWordSemanticRecord(record);
    if (!checked.ok) return bad("BLOCKED", "SEMANTIC_RECORD_INVALID_AFTER_CONTEXTUALIZATION:" + checked.reason);
    record = checked.value;

    const classified = await stage("CLASSIFY_SEMANTICS", classify, { requestId, principalId, source, context, record });
    if (!classified.ok) return classified;
    record = classified.value;
    checked = validateWordSemanticRecord(record);
    if (!checked.ok) return bad("BLOCKED", "SEMANTIC_RECORD_INVALID_AFTER_CLASSIFICATION:" + checked.reason);
    record = checked.value;

    const reviewed = await stage("CRITIC_REVIEW", critic, { requestId, principalId, source, context, record });
    if (!reviewed.ok) return reviewed;
    const verdict = reviewed.value.verdict ?? reviewed.value.decision;
    if (verdict !== "ACCEPT") {
      return bad(verdict === "REVISE" ? "NEEDS_REVIEW" : "BLOCKED", "SEMANTIC_CRITIC_DID_NOT_ACCEPT", {
        verdict: typeof verdict === "string" ? verdict : "MISSING",
        issues: Array.isArray(reviewed.value.issues) ? reviewed.value.issues : []
      });
    }

    try {
      return await ingestion.ingest({ requestId, principalId, record, approval });
    } catch {
      return bad("BLOCKED", "SEMANTIC_INGESTION_RUNTIME_FAILED");
    }
  }

  return Object.freeze({ run });
}
