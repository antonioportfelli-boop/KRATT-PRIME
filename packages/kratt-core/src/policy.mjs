import {
  POLICY_DECISIONS,
  validateApprovalArtifact,
  validateEvidenceRecord,
  validateTaskEnvelope,
  validateTrustedContext
} from "./contracts.mjs";

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

function safelyVerify(verifier, ...args) {
  if (typeof verifier !== "function") return false;
  try { return verifier(...args) === true; }
  catch { return false; }
}

/**
 * Deterministic policy evaluator.
 *
 * The trusted context and verifier callbacks must be supplied by a server-owned
 * composition root. Never pass model-, task-, or connector-authored verifier
 * functions here. This module does not itself establish the authenticity of
 * that composition root.
 *
 * options: { now, maxContextAgeMs, approval, verifyApproval, verifyEvidence }
 */
export function evaluatePolicy(taskInput, evidenceInput, trustedContextInput, options = {}) {
  const task = validateTaskEnvelope(taskInput);
  const taskId = task.ok ? task.value.task_id : "invalid";
  const context = validateTrustedContext(trustedContextInput);
  const evaluatedAt = context.ok ? context.value.evaluated_at : null;
  if (!task.ok) return decision(taskId, "DENY", ["INVALID_TASK_ENVELOPE"], [], evaluatedAt);
  if (!context.ok) return decision(taskId, "BLOCKED", ["INVALID_TRUSTED_CONTEXT"], [], null);

  const t = task.value, c = context.value;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxContextAgeMs = Number.isFinite(options.maxContextAgeMs) && options.maxContextAgeMs >= 0
    ? options.maxContextAgeMs : 5 * 60 * 1000;

  if (t.status !== "PENDING")
    return decision(t.task_id, "DENY", [t.status === "CANCELLED" ? "TASK_CANCELLED" : "TASK_NOT_PENDING"], [], evaluatedAt);
  if (c.kill_switch)
    return decision(t.task_id, "DENY", ["GLOBAL_KILL_SWITCH_ACTIVE"], [], evaluatedAt);

  const contextTime = Date.parse(c.evaluated_at), contextExpiry = Date.parse(c.expires_at);
  if (contextTime > now || contextExpiry <= now || now - contextTime > maxContextAgeMs)
    return decision(t.task_id, "BLOCKED", ["TRUSTED_CONTEXT_STALE_OR_EXPIRED"], [], evaluatedAt);

  if (!Array.isArray(evidenceInput) || evidenceInput.length > 256)
    return decision(t.task_id, "INSUFFICIENT_EVIDENCE", ["INVALID_EVIDENCE_SET"], [], evaluatedAt);
  if (!c.policies.length)
    return decision(t.task_id, "BLOCKED", ["MISSING_POLICY"], [], evaluatedAt);

  const matchingRules = c.policies.filter(p => p.action === t.action);
  if (matchingRules.length > 1)
    return decision(t.task_id, "BLOCKED", ["POLICY_CONFLICT"], [], evaluatedAt);
  const rule = matchingRules[0];
  if (!rule) return decision(t.task_id, "DENY", ["UNSUPPORTED_ACTION"], [], evaluatedAt);
  if (!c.authorities.includes(rule.required_authority))
    return decision(t.task_id, "DENY", ["MISSING_TRUSTED_AUTHORIZATION"], [], evaluatedAt);

  const target = c.allowed_targets.find(x =>
    x.resource_type === t.target.resource_type &&
    x.resource_id === t.target.resource_id &&
    (t.constraints.branch === undefined || x.branch === t.constraints.branch) &&
    (t.constraints.path === undefined || x.path === t.constraints.path)
  );
  if (!rule.target_types.includes(t.target.resource_type) || !target)
    return decision(t.task_id, "DENY", ["TARGET_OUT_OF_SCOPE"], [], evaluatedAt);

  const records = [], seen = new Set(), notes = [];
  for (const raw of evidenceInput) {
    const parsed = validateEvidenceRecord(raw);
    if (!parsed.ok) {
      if (!notes.includes("INVALID_EVIDENCE_IGNORED")) notes.push("INVALID_EVIDENCE_IGNORED");
      continue;
    }
    if (seen.has(parsed.value.evidence_id))
      return decision(t.task_id, "DENY", ["DUPLICATE_EVIDENCE_ID"], [], evaluatedAt);
    seen.add(parsed.value.evidence_id);
    records.push(parsed.value);
  }

  const used = [], failures = [];
  for (const req of t.required_evidence) {
    if (!req.required) continue;
    const matches = records.filter(e =>
      e.result === "VERIFIED" &&
      e.claim_type === req.claim_type &&
      e.subject === req.subject &&
      safelyVerify(options.verifyEvidence, e, t, c)
    );
    const found = req.revision === null
      ? matches[0]
      : matches.find(e => e.source.revision === req.revision);
    if (found) used.push(found.evidence_id);
    else failures.push("MISSING_OR_UNTRUSTED_REQUIRED_EVIDENCE");
  }
  if (failures.length)
    return decision(t.task_id, "INSUFFICIENT_EVIDENCE", [...new Set(failures), ...notes], [], evaluatedAt);

  // A missing side_effect declaration is deliberately treated as a write.
  if ((rule.side_effect ?? "EXTERNAL_WRITE") === "EXTERNAL_WRITE") {
    const parsedApproval = validateApprovalArtifact(options.approval);
    if (!parsedApproval.ok)
      return decision(t.task_id, "DENY", ["MISSING_OR_INVALID_REQUEST_BOUND_APPROVAL"], [], evaluatedAt);
    const a = parsedApproval.value;
    const approvalMatches =
      a.task_id === t.task_id &&
      a.actor === t.actor &&
      a.provider === rule.provider &&
      a.operation === t.action &&
      a.target.resource_type === t.target.resource_type &&
      a.target.resource_id === t.target.resource_id &&
      Date.parse(a.issued_at) <= now &&
      Date.parse(a.expires_at) > now;
    if (!approvalMatches || !safelyVerify(options.verifyApproval, a, t, c))
      return decision(t.task_id, "DENY", ["APPROVAL_NOT_BOUND_OR_NOT_TRUSTED"], [], evaluatedAt);
  }

  return decision(t.task_id, "ALLOW", ["ALL_CONDITIONS_SATISFIED", ...notes], used, evaluatedAt);
}

export function isPolicyDecision(value) {
  return value && POLICY_DECISIONS.includes(value.decision);
}
