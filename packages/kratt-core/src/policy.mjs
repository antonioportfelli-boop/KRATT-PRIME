import { createHash } from "node:crypto";
import { POLICY_DECISIONS, SIDE_EFFECT_CLASSES, validateEvidenceRecord, validateTaskEnvelope, validateTrustedContext } from "./contracts.mjs";
import { canonicalizeEvidencePayload } from "./evidence-integrity.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const APPROVAL_MAX_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const APPROVAL_KEYS = ["schema_version", "approval_id", "task_id", "actor", "provider", "operation", "target", "request_digest", "key_id", "nonce", "issued_at", "expires_at", "decision", "approved_by", "authority", "signature"];

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function denseArray(value, max = 256) {
  if (!Array.isArray(value) || value.length > max) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(k => typeof k !== "string" || (k !== "length" && !/^(0|[1-9][0-9]*)$/.test(k)))) return false;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) return false;
  }
  return true;
}
function safeObject(value, allowed) {
  if (!plain(value)) return false;
  return Reflect.ownKeys(value).every(k => typeof k === "string" && allowed.includes(k) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, k) ?? {}, "value") && Object.getOwnPropertyDescriptor(value, k).enumerable);
}
function decision(taskId, value, reasons, evidenceIds = [], evaluatedAt = null) {
  return Object.freeze({ schema_version: "kratt-prime/v0.1", decision_id: `decision:${taskId}`, task_id: taskId, decision: value,
    reasons: Object.freeze(reasons), evidence_ids: Object.freeze(evidenceIds), evaluated_at: evaluatedAt });
}

export function canonicalTaskDigest(input) {
  const checked = validateTaskEnvelope(input);
  if (!checked.ok) return null;
  try { return `sha256:${createHash("sha256").update(canonicalizeEvidencePayload(checked.value), "utf8").digest("hex")}`; }
  catch { return null; }
}

function validApproval(value) {
  if (!safeObject(value, APPROVAL_KEYS) || APPROVAL_KEYS.some(k => !Object.hasOwn(value, k))) return false;
  const target = value.target;
  if (!safeObject(target, ["resource_type", "resource_id"]) || Reflect.ownKeys(target).length !== 2) return false;
  const time = v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
  return value.schema_version === "kratt-prime/v0.1" &&
    [value.approval_id, value.task_id, value.actor, value.provider, value.operation, value.key_id, value.nonce, value.approved_by, value.authority].every(v => typeof v === "string" && ID.test(v)) &&
    typeof target.resource_type === "string" && ID.test(target.resource_type) && typeof target.resource_id === "string" && target.resource_id.length > 0 && target.resource_id.length <= 512 &&
    typeof value.request_digest === "string" && DIGEST.test(value.request_digest) && time(value.issued_at) && time(value.expires_at) &&
    value.decision === "APPROVE" && typeof value.signature === "string" && value.signature.length > 0 && value.signature.length <= 8192;
}

export function canonicalApprovalPayload(artifact) {
  if (!validApproval(artifact)) return null;
  return JSON.stringify({ schema_version: artifact.schema_version, approval_id: artifact.approval_id, task_id: artifact.task_id,
    actor: artifact.actor, provider: artifact.provider, operation: artifact.operation,
    target: { resource_type: artifact.target.resource_type, resource_id: artifact.target.resource_id },
    request_digest: artifact.request_digest, key_id: artifact.key_id, nonce: artifact.nonce, issued_at: artifact.issued_at,
    expires_at: artifact.expires_at, decision: artifact.decision, approved_by: artifact.approved_by, authority: artifact.authority });
}

export function createRequestBoundApprovalVerifier({ verifySignature, consumeNonce, now = () => Date.now() } = {}) {
  if (typeof verifySignature !== "function" || typeof consumeNonce !== "function" || typeof now !== "function") throw new TypeError("TRUSTED_APPROVAL_DEPENDENCIES_REQUIRED");
  return (artifact, binding) => {
    if (!validApproval(artifact) || !plain(binding)) return false;
    let current;
    try { current = now(); } catch { return false; }
    const issued = Date.parse(artifact.issued_at), expires = Date.parse(artifact.expires_at);
    if (!Number.isFinite(current) || issued > current + CLOCK_SKEW_MS || expires <= current || expires <= issued || expires - issued > APPROVAL_MAX_AGE_MS || current - issued > APPROVAL_MAX_AGE_MS) return false;
    if (artifact.task_id !== binding.task_id || artifact.actor !== binding.actor || artifact.provider !== binding.provider || artifact.operation !== binding.operation ||
      artifact.target.resource_type !== binding.target?.resource_type || artifact.target.resource_id !== binding.target?.resource_id ||
      artifact.authority !== binding.authority || artifact.request_digest !== binding.request_digest || artifact.decision !== "APPROVE") return false;
    try {
      if (verifySignature(canonicalApprovalPayload(artifact), artifact.signature, artifact) !== true) return false;
      const consumed = consumeNonce(artifact.nonce, artifact.approval_id, artifact.expires_at, artifact.key_id, current);
      return consumed === true;
    } catch { return false; }
  };
}

export function evaluatePolicy(taskInput, evidenceInput, contextInput, options = {}) {
  const taskCheck = validateTaskEnvelope(taskInput);
  const taskId = taskCheck.ok ? taskCheck.value.task_id : "invalid";
  const contextCheck = validateTrustedContext(contextInput);
  const at = contextCheck.ok ? contextCheck.value.evaluated_at : null;
  if (!taskCheck.ok) return decision(taskId, "DENY", ["INVALID_TASK_ENVELOPE"], [], at);
  if (!contextCheck.ok) return decision(taskId, "BLOCKED", ["INVALID_TRUSTED_CONTEXT", ...contextCheck.errors], [], null);
  const task = taskCheck.value, context = contextCheck.value;
  if (!plain(options) || !Number.isFinite(options.now) || options.now < 0) return decision(taskId, "BLOCKED", ["TRUSTED_TIME_REQUIRED"], [], at);
  const now = options.now;
  if (task.status !== "PENDING") return decision(taskId, "DENY", [task.status === "CANCELLED" ? "TASK_CANCELLED" : "TASK_NOT_PENDING"], [], at);
  if (context.kill_switch) return decision(taskId, "DENY", ["GLOBAL_KILL_SWITCH_ACTIVE"], [], at);
  const age = now - Date.parse(context.evaluated_at);
  const maxAge = Number.isFinite(options.maxContextAgeMs) && options.maxContextAgeMs >= 0 ? options.maxContextAgeMs : 300_000;
  if (Date.parse(context.evaluated_at) > now + CLOCK_SKEW_MS || Date.parse(context.expires_at) <= now || age > maxAge) return decision(taskId, "BLOCKED", ["TRUSTED_CONTEXT_STALE_OR_EXPIRED"], [], at);
  if (!denseArray(evidenceInput)) return decision(taskId, "INSUFFICIENT_EVIDENCE", ["INVALID_EVIDENCE_SET"], [], at);
  const policyList = context.policies;
  if (!denseArray(policyList, 64) || policyList.length === 0) return decision(taskId, "BLOCKED", ["MISSING_POLICY"], [], at);
  const rules = policyList.filter(p => p.action === task.action);
  if (!rules.length) return decision(taskId, "DENY", ["UNSUPPORTED_ACTION"], [], at);
  const applicable = rules.filter(p => p.target_types.includes(task.target.resource_type));
  if (!applicable.length) return decision(taskId, "DENY", ["TARGET_TYPE_NOT_ALLOWED"], [], at);
  if (applicable.length !== 1) return decision(taskId, "BLOCKED", ["POLICY_CONFLICT"], [], at);
  const rule = applicable[0];
  if (!context.authorities.includes(rule.required_authority)) return decision(taskId, "DENY", ["MISSING_TRUSTED_AUTHORIZATION"], [], at);
  const scoped = context.allowed_targets.some(t => t.resource_type === task.target.resource_type && t.resource_id === task.target.resource_id &&
    (t.branch === undefined ? task.constraints.branch === undefined : t.branch === task.constraints.branch) &&
    (t.path === undefined ? task.constraints.path === undefined : t.path === task.constraints.path));
  if (!scoped) return decision(taskId, "DENY", ["TARGET_OUT_OF_SCOPE"], [], at);
  const side = rule.side_effect_class;
  if (!SIDE_EFFECT_CLASSES.includes(side)) return decision(taskId, "BLOCKED", ["POLICY_SIDE_EFFECT_INVALID"], [], at);
  const writing = ["LOCAL_WRITE", "EXTERNAL_WRITE", "IRREVERSIBLE"].includes(side);
  if (writing) {
    const claims = rule.required_claims ?? [];
    if (!claims.length) return decision(taskId, "BLOCKED", ["WRITE_REQUIRES_POLICY_EVIDENCE"], [], at);
    if (task.required_evidence.some(e => e.required && e.subject !== task.target.resource_id)) return decision(taskId, "DENY", ["TASK_EVIDENCE_TARGET_MISMATCH"], [], at);
    if (claims.some(claim => !task.required_evidence.some(e => e.required && e.claim_type === claim && e.subject === task.target.resource_id))) return decision(taskId, "DENY", ["TASK_WEAKENS_POLICY_EVIDENCE"], [], at);
  }
  const needsApproval = rule.approval_required === true || ["EXTERNAL_WRITE", "IRREVERSIBLE"].includes(side);
  let binding = null;
  if (needsApproval) {
    if (!rule.approval_authority || typeof options.approvalVerifier !== "function" || !options.approval || typeof task.constraints.provider !== "string" || !task.constraints.provider.trim()) return decision(taskId, "DENY", ["REQUEST_BOUND_APPROVAL_REQUIRED"], [], at);
    binding = { task_id: task.task_id, actor: task.actor, provider: task.constraints.provider, operation: task.action, target: task.target, authority: rule.approval_authority, request_digest: canonicalTaskDigest(task) };
  }
  const verified = [], ids = new Set(), notes = [];
  for (const raw of evidenceInput) {
    const checked = validateEvidenceRecord(raw);
    if (!checked.ok) { if (!notes.includes("INVALID_EVIDENCE_IGNORED")) notes.push("INVALID_EVIDENCE_IGNORED"); continue; }
    const evidence = checked.value;
    if (ids.has(evidence.evidence_id)) return decision(taskId, "DENY", ["DUPLICATE_EVIDENCE_ID"], [], at);
    ids.add(evidence.evidence_id);
    let trusted = false;
    try { trusted = options.verifyEvidence?.(evidence, { task_id: taskId, actor: task.actor, action: task.action, target: task.target }) === true; } catch { trusted = false; }
    if (trusted && evidence.result === "VERIFIED") verified.push(evidence);
  }
  const requirements = [...task.required_evidence.filter(e => e.required), ...(writing ? (rule.required_claims ?? []).map(claim_type => ({ claim_type, subject: task.target.resource_id, revision: null })) : [])];
  const missing = [], used = [];
  for (const req of requirements) {
    const matches = verified.filter(e => e.claim_type === req.claim_type && e.subject === req.subject);
    const found = req.revision === null || req.revision === undefined ? matches[0] : matches.find(e => e.source.revision === req.revision);
    if (!found) missing.push(matches.length ? "EVIDENCE_REVISION_MISMATCH" : "MISSING_TRUSTED_EVIDENCE");
    else if (!used.includes(found.evidence_id)) used.push(found.evidence_id);
  }
  if (missing.length) return decision(taskId, "INSUFFICIENT_EVIDENCE", [...new Set(missing), ...notes], [], at);
  if (binding) {
    let approved = false;
    try { approved = options.approvalVerifier(options.approval, binding) === true; } catch { approved = false; }
    if (!approved) return decision(taskId, "DENY", ["APPROVAL_INVALID_OR_MISSING"], [], at);
  }
  return decision(taskId, "ALLOW", ["ALL_CONDITIONS_SATISFIED", ...notes], used, at);
}

export function isPolicyDecision(value) { return plain(value) && POLICY_DECISIONS.includes(value.decision); }
