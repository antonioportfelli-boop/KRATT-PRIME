import { POLICY_DECISIONS, validateEvidenceRecord, validateTaskEnvelope, validateTrustedContext } from "./contracts.mjs";

function decision(taskId, value, reasons, evidenceIds, evaluatedAt) {
  return Object.freeze({
    schema_version: "kratt-prime/v0.1",
    decision_id: `decision:${taskId}`,
    task_id: taskId,
    decision: value,
    reasons: Object.freeze(reasons),
    evidence_ids: Object.freeze(evidenceIds),
    evaluated_at: evaluatedAt
  });
}

/**
 * Pure authorization evaluator.
 *
 * verifyEvidence MUST be supplied by the trusted composition root (for example,
 * a server-side verifier backed by authenticated provider responses/signatures).
 * The request payload's result enum is never proof of verification.
 *
 * options.now is an injectable trusted clock, in milliseconds since epoch.
 * approvalVerifier is a trusted request-bound approval verifier. This increment
 * requires it for policies marked approval_required; no request-side boolean grants approval.
 */
export function evaluatePolicy(taskInput, evidenceInput, trustedContextInput, options = {}) {
  const task = validateTaskEnvelope(taskInput);
  const taskId = task.ok ? task.value.task_id : "invalid";
  const context = validateTrustedContext(trustedContextInput);
  const evaluatedAt = context.ok ? context.value.evaluated_at : null;
  if (!task.ok) return decision(taskId,"DENY",["INVALID_TASK_ENVELOPE"],[],evaluatedAt);
  if (!context.ok) return decision(taskId,"BLOCKED",["INVALID_TRUSTED_CONTEXT"],[],null);

  const t = task.value, c = context.value;
  if (t.status === "CANCELLED") return decision(t.task_id,"DENY",["TASK_CANCELLED"],[],evaluatedAt);
  if (!Array.isArray(evidenceInput) || evidenceInput.length > 256)
    return decision(t.task_id,"INSUFFICIENT_EVIDENCE",["INVALID_EVIDENCE_SET"],[],evaluatedAt);
  if (!c.policies?.length) return decision(t.task_id,"BLOCKED",["MISSING_POLICY"],[],evaluatedAt);

  const applicable = c.policies.filter(p => p.action === t.action);
  if (applicable.length === 0) return decision(t.task_id,"DENY",["UNSUPPORTED_ACTION"],[],evaluatedAt);
  if (applicable.length !== 1) return decision(t.task_id,"BLOCKED",["POLICY_CONFLICT"],[],evaluatedAt);
  const rule = applicable[0];

  if (!c.authorities.includes(rule.required_authority))
    return decision(t.task_id,"DENY",["MISSING_TRUSTED_AUTHORIZATION"],[],evaluatedAt);
  const inScope = rule.target_types.includes(t.target.resource_type) &&
    c.allowed_targets.some(x => x.resource_type === t.target.resource_type && x.resource_id === t.target.resource_id);
  if (!inScope) return decision(t.task_id,"DENY",["TARGET_OUT_OF_SCOPE"],[],evaluatedAt);

  const now = typeof options.now === "number" ? options.now : Date.now();
  const contextTime = Date.parse(c.evaluated_at);
  if (!Number.isFinite(now) || contextTime > now + 30_000 || now - contextTime > 5 * 60_000)
    return decision(t.task_id,"BLOCKED",["TRUSTED_CONTEXT_STALE"],[],evaluatedAt);

  const sideEffect = rule.side_effect_class ?? (/\\b(write|push|merge|delete|deploy|create|update|send|post)\\b/i.test(t.action) ? "EXTERNAL_WRITE" : "READ_ONLY");
  if (["EXTERNAL_WRITE","IRREVERSIBLE"].includes(sideEffect)) {
    if (t.required_evidence.length === 0 || !t.required_evidence.some(x => x.required))
      return decision(t.task_id,"DENY",["WRITE_REQUIRES_EVIDENCE"],[],evaluatedAt);
    if (rule.approval_required !== true || typeof options.approvalVerifier !== "function")
      return decision(t.task_id,"DENY",["REQUEST_BOUND_APPROVAL_REQUIRED"],[],evaluatedAt);
    let approved = false;
    try { approved = options.approvalVerifier(Object.freeze({
      task_id:t.task_id, actor:t.actor, provider:t.constraints.provider,
      operation:t.action, target:Object.freeze({...t.target}), now
    })) === true; } catch { approved = false; }
    if (!approved) return decision(t.task_id,"DENY",["APPROVAL_INVALID_OR_MISSING"],[],evaluatedAt);
  }

  const records = [], seen = new Set(), notes = [];
  for (const raw of evidenceInput) {
    const e = validateEvidenceRecord(raw);
    if (!e.ok) { if (!notes.includes("INVALID_EVIDENCE_IGNORED")) notes.push("INVALID_EVIDENCE_IGNORED"); continue; }
    if (seen.has(e.value.evidence_id)) return decision(t.task_id,"DENY",["DUPLICATE_EVIDENCE_ID"],[],evaluatedAt);
    seen.add(e.value.evidence_id);
    let verified = false;
    if (typeof options.verifyEvidence === "function") {
      try { verified = options.verifyEvidence(e.value, Object.freeze({task_id:t.task_id, actor:t.actor, action:t.action, target:Object.freeze({...t.target})})) === true; }
      catch { verified = false; }
    }
    if (verified && e.value.result === "VERIFIED") records.push(e.value);
  }

  const used = [], failures = [];
  for (const req of t.required_evidence) {
    if (!req.required) continue;
    const matches = records.filter(e => e.claim_type === req.claim_type && e.subject === req.subject);
    const found = req.revision === null ? matches[0] : matches.find(e => e.source.revision === req.revision);
    if (found) used.push(found.evidence_id);
    else failures.push(matches.length ? "EVIDENCE_REVISION_MISMATCH" : "MISSING_TRUSTED_EVIDENCE");
  }
  if (failures.length) return decision(t.task_id,"INSUFFICIENT_EVIDENCE",[...new Set(failures),...notes],[],evaluatedAt);
  return decision(t.task_id,"ALLOW",["ALL_CONDITIONS_SATISFIED",...notes],used,evaluatedAt);
}

export function isPolicyDecision(value) {
  return value && POLICY_DECISIONS.includes(value.decision);
}
