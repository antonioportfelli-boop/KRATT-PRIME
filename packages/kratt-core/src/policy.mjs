import { POLICY_DECISIONS, validateEvidenceRecord, validateTaskEnvelope, validateTrustedContext } from "./contracts.mjs";

const DEFAULT_CONTEXT_MAX_AGE_MS = 60_000;

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

function safeVerify(verifier, value, binding) {
  if (typeof verifier !== "function") return false;
  try { return verifier(value, binding) === true; }
  catch { return false; }
}

function approvalMatches(approval, task, nowMs, verifyApproval) {
  const keys = ["approval_id","request_id","provider","operation","target","branch","path","expires_at"];
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
  if (Object.keys(approval).sort().join("|") !== [...keys].sort().join("|")) return false;
  if (typeof approval.approval_id !== "string" || !approval.approval_id ||
      approval.request_id !== task.task_id ||
      typeof approval.provider !== "string" || typeof approval.operation !== "string" ||
      !approval.target || approval.target.resource_type !== task.target.resource_type ||
      approval.target.resource_id !== task.target.resource_id ||
      typeof approval.expires_at !== "string" || !Number.isFinite(Date.parse(approval.expires_at)) ||
      Date.parse(approval.expires_at) <= nowMs) return false;
  const constraints = task.constraints;
  if (approval.provider !== constraints.provider || approval.operation !== constraints.operation) return false;
  if ((constraints.branch ?? null) !== (approval.branch ?? null)) return false;
  if ((constraints.path ?? null) !== (approval.path ?? null)) return false;
  return safeVerify(verifyApproval, approval, {
    request_id: task.task_id, provider: constraints.provider, operation: constraints.operation,
    target: task.target, branch: constraints.branch ?? null, path: constraints.path ?? null
  });
}

/**
 * Deterministic policy evaluator. For write-class actions, a trusted approval
 * verifier is mandatory. For required evidence, a trusted evidence verifier
 * must admit each record; caller-supplied result="VERIFIED" is never sufficient.
 *
 * security: { now?, verifyApproval?, approval?, verifyEvidence? }
 * Verifier callbacks must be supplied by a trusted host boundary, not by task data.
 */
export function evaluatePolicy(taskInput, evidenceInput, trustedContextInput, security = {}) {
  const task = validateTaskEnvelope(taskInput);
  const taskId = task.ok ? task.value.task_id : "invalid";
  const context = validateTrustedContext(trustedContextInput);
  const evaluatedAt = context.ok ? context.value.evaluated_at : null;
  if (!task.ok) return decision(taskId,"DENY",["INVALID_TASK_ENVELOPE"],[],evaluatedAt);
  if (!context.ok) return decision(taskId,"BLOCKED",["INVALID_TRUSTED_CONTEXT"],[],null);
  if (!security || typeof security !== "object" || Array.isArray(security))
    return decision(taskId,"BLOCKED",["INVALID_SECURITY_CONTEXT"],[],evaluatedAt);

  const t = task.value, c = context.value;
  if (t.status !== "PENDING") return decision(t.task_id,"DENY",["TASK_NOT_PENDING"],[],evaluatedAt);
  const nowMs = security.now === undefined ? Date.now() : Date.parse(security.now);
  if (!Number.isFinite(nowMs)) return decision(t.task_id,"BLOCKED",["INVALID_EVALUATION_TIME"],[],evaluatedAt);
  const ruleMatches = c.policies?.filter(p => p.action === t.action) ?? [];
  if (!ruleMatches.length) return decision(t.task_id,"DENY",["UNSUPPORTED_ACTION"],[],evaluatedAt);
  if (ruleMatches.length !== 1) return decision(t.task_id,"BLOCKED",["POLICY_CONFLICT"],[],evaluatedAt);
  const rule = ruleMatches[0];
  const maxAge = rule.max_context_age_ms ?? DEFAULT_CONTEXT_MAX_AGE_MS;
  const contextAge = nowMs - Date.parse(c.evaluated_at);
  if (contextAge < 0 || contextAge > maxAge)
    return decision(t.task_id,"BLOCKED",["TRUSTED_CONTEXT_EXPIRED"],[],evaluatedAt);
  if (!c.authorities.includes(rule.required_authority))
    return decision(t.task_id,"DENY",["MISSING_TRUSTED_AUTHORIZATION"],[],evaluatedAt);
  const inScope = rule.target_types.includes(t.target.resource_type) &&
    c.allowed_targets.some(x => x.resource_type === t.target.resource_type && x.resource_id === t.target.resource_id);
  if (!inScope) return decision(t.task_id,"DENY",["TARGET_OUT_OF_SCOPE"],[],evaluatedAt);

  const constraints = t.constraints;
  if (constraints.branch !== undefined &&
      (!Array.isArray(rule.allowed_branches) || !rule.allowed_branches.includes(constraints.branch)))
    return decision(t.task_id,"DENY",["BRANCH_OUT_OF_SCOPE"],[],evaluatedAt);
  if (constraints.path !== undefined &&
      (!Array.isArray(rule.allowed_paths) || !rule.allowed_paths.some(p => constraints.path === p || constraints.path.startsWith(p.endsWith("/") ? p : p + "/"))))
    return decision(t.task_id,"DENY",["PATH_OUT_OF_SCOPE"],[],evaluatedAt);

  const sideEffect = rule.side_effect_class ?? "READ_ONLY";
  if (sideEffect !== "READ_ONLY" &&
      !approvalMatches(security.approval, t, nowMs, security.verifyApproval))
    return decision(t.task_id,"DENY",["REQUEST_BOUND_APPROVAL_REQUIRED"],[],evaluatedAt);

  if (!Array.isArray(evidenceInput) || evidenceInput.length > 256)
    return decision(t.task_id,"INSUFFICIENT_EVIDENCE",["INVALID_EVIDENCE_SET"],[],evaluatedAt);
  const records = [], seen = new Set(), notes = [];
  for (const raw of evidenceInput) {
    const e = validateEvidenceRecord(raw);
    if (!e.ok) { if (!notes.includes("INVALID_EVIDENCE_IGNORED")) notes.push("INVALID_EVIDENCE_IGNORED"); continue; }
    if (seen.has(e.value.evidence_id)) return decision(t.task_id,"DENY",["DUPLICATE_EVIDENCE_ID"],[],evaluatedAt);
    seen.add(e.value.evidence_id);
    if (e.value.result !== "VERIFIED" || !safeVerify(security.verifyEvidence, e.value, {task_id:t.task_id, action:t.action, target:t.target}))
      continue;
    records.push(e.value);
  }
  const used = [], failures = [];
  for (const req of t.required_evidence) {
    if (!req.required) continue;
    const matches = records.filter(e => e.claim_type === req.claim_type && e.subject === req.subject);
    const found = req.revision === null ? matches[0] : matches.find(e => e.source.revision === req.revision);
    if (found) used.push(found.evidence_id);
    else failures.push("MISSING_OR_UNTRUSTED_REQUIRED_EVIDENCE");
  }
  if (failures.length) return decision(t.task_id,"INSUFFICIENT_EVIDENCE",[...new Set(failures),...notes],[],evaluatedAt);
  return decision(t.task_id,"ALLOW",["ALL_CONDITIONS_SATISFIED",...notes],used,evaluatedAt);
}

export function isPolicyDecision(value) {
  return value && POLICY_DECISIONS.includes(value.decision);
}
