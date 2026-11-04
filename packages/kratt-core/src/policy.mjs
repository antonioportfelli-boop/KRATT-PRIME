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

  const actionTail = t.action.split(/[.:_-]/).at(-1).toLowerCase();
  const sideEffect = rule.side_effect_class ??
    (/^(read|list|get|fetch|search|inspect|status|verify|compare)$/.test(actionTail) ? "READ_ONLY" : "EXTERNAL_WRITE");
  if (["EXTERNAL_WRITE","IRREVERSIBLE"].includes(sideEffect)) {
    if (t.required_evidence.length === 0 || !t.required_evidence.some(x => x.required))
      return decision(t.task_id,"DENY",["WRITE_REQUIRES_EVIDENCE"],[],evaluatedAt);
    if (rule.approval_required !== true || typeof options.approvalVerifier !== "function" ||
        typeof t.constraints.provider !== "string" || !t.constraints.provider.trim() ||
        !options.approval || typeof options.approval !== "object")
      return decision(t.task_id,"DENY",["REQUEST_BOUND_APPROVAL_REQUIRED"],[],evaluatedAt);
    let approved = false;
    try { approved = options.approvalVerifier(options.approval, Object.freeze({
      task_id:t.task_id, actor:t.actor, provider:t.constraints.provider,
      operation:t.action, target:Object.freeze({...t.target}), authority:rule.required_authority, now
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


const APPROVAL_MAX_AGE_MS = 5 * 60_000;
const APPROVAL_CLOCK_SKEW_MS = 30_000;
const APPROVAL_KEYS = ["schema_version","approval_id","task_id","actor","provider","operation","target","nonce","issued_at","expires_at","decision","approved_by","authority","signature"];

function isApprovalArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== "string" || !APPROVAL_KEYS.includes(k)) ||
      APPROVAL_KEYS.some(k => !Object.hasOwn(value,k)) ||
      keys.some(k => { const d=Object.getOwnPropertyDescriptor(value,k); return !d || !("value" in d) || d.get || d.set; })) return false;
  const target = value.target;
  if (!target || typeof target !== "object" || Array.isArray(target) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(target)) ||
      Object.keys(target).length !== 2 || !Object.hasOwn(target,"resource_type") ||
      !Object.hasOwn(target,"resource_id") ||
      Object.keys(target).some(k => { const d=Object.getOwnPropertyDescriptor(target,k); return !d || !("value" in d) || d.get || d.set; })) return false;
  const timestamp = v => typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
  return value.schema_version === "kratt-prime/v0.1" &&
    [value.approval_id,value.task_id,value.actor,value.provider,value.operation,value.nonce,value.approved_by,value.authority]
      .every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v)) &&
    typeof target.resource_type === "string" && target.resource_type.length > 0 &&
    typeof target.resource_id === "string" && target.resource_id.length > 0 &&
    timestamp(value.issued_at) && timestamp(value.expires_at) &&
    value.decision === "APPROVE" &&
    typeof value.signature === "string" && value.signature.length > 0 && value.signature.length <= 8192;
}

/** Stable signed representation. Signature is deliberately excluded from its own payload. */
export function canonicalApprovalPayload(artifact) {
  if (!isApprovalArtifact(artifact)) return null;
  return JSON.stringify({
    schema_version:artifact.schema_version, approval_id:artifact.approval_id,
    task_id:artifact.task_id, actor:artifact.actor, provider:artifact.provider,
    operation:artifact.operation, target:{resource_type:artifact.target.resource_type,resource_id:artifact.target.resource_id},
    nonce:artifact.nonce, issued_at:artifact.issued_at, expires_at:artifact.expires_at,
    decision:artifact.decision, approved_by:artifact.approved_by, authority:artifact.authority
  });
}

/**
 * Build a synchronous trusted approval verifier.
 * verifySignature(payload, signature, artifact) must validate a real signature
 * against provisioned trusted public-key material. consumeNonce must atomically
 * consume a nonce in durable shared storage and return true exactly once.
 * Missing, asynchronous, throwing, or false dependencies fail closed.
 */
export function createRequestBoundApprovalVerifier({verifySignature, consumeNonce, now = () => Date.now()} = {}) {
  if (typeof verifySignature !== "function" || typeof consumeNonce !== "function" || typeof now !== "function")
    throw new TypeError("TRUSTED_APPROVAL_DEPENDENCIES_REQUIRED");
  return (artifact, binding) => {
    if (!isApprovalArtifact(artifact) || !binding || typeof binding !== "object") return false;
    const current = now();
    const issued = Date.parse(artifact.issued_at), expires = Date.parse(artifact.expires_at);
    if (!Number.isFinite(current) || issued > current + APPROVAL_CLOCK_SKEW_MS ||
        expires <= current || expires <= issued || expires - issued > APPROVAL_MAX_AGE_MS ||
        current - issued > APPROVAL_MAX_AGE_MS) return false;
    if (artifact.task_id !== binding.task_id || artifact.actor !== binding.actor ||
        artifact.provider !== binding.provider || artifact.operation !== binding.operation ||
        artifact.target.resource_type !== binding.target?.resource_type ||
        artifact.target.resource_id !== binding.target?.resource_id ||
        artifact.authority !== binding.authority || artifact.decision !== "APPROVE") return false;
    const payload = canonicalApprovalPayload(artifact);
    try {
      if (verifySignature(payload, artifact.signature, artifact) !== true) return false;
      // This must be an atomic durable compare-and-consume operation.
      if (consumeNonce(artifact.nonce, artifact.approval_id, artifact.expires_at) !== true) return false;
      return true;
    } catch { return false; }
  };
}

export function isPolicyDecision(value) {
  return value && POLICY_DECISIONS.includes(value.decision);
}
