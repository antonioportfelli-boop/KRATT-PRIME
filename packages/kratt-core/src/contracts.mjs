export const KRATT_SCHEMA_VERSION = "kratt-prime/v0.1";
export const TASK_STATES = Object.freeze(["PENDING", "EVALUATED", "CANCELLED"]);
export const POLICY_DECISIONS = Object.freeze(["ALLOW", "DENY", "BLOCKED", "INSUFFICIENT_EVIDENCE"]);
export const EVIDENCE_RESULTS = Object.freeze(["VERIFIED", "REJECTED", "UNAVAILABLE"]);
export const EVIDENCE_CLAIMS = Object.freeze([
  "COMMIT_MERGED", "TESTS_PASSED", "BUILD_SUCCEEDED",
  "SECURITY_CONTROL_VERIFIED", "ARTIFACT_CREATED",
  "DEPLOYMENT_COMPLETED", "INTEGRATION_VERIFIED"
]);
export const SIDE_EFFECT_CLASSES = Object.freeze(["READ_ONLY", "LOCAL_WRITE", "EXTERNAL_WRITE", "IRREVERSIBLE"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function denseArray(value, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== "string" ||
      (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return false;
  }
  return true;
}

function scalarRecord(value, maxLength, maxStringLength = 512) {
  if (!plainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxLength || keys.some(key => typeof key !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return false;
    const item = descriptor.value;
    return item === null || typeof item === "boolean" ||
      (typeof item === "string" && item.length <= maxStringLength) ||
      (typeof item === "number" && Number.isFinite(item));
  });
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !allowed.has(key))) return false;
  if (required.some(key => !Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable;
  });
}

const validId = value => typeof value === "string" && ID.test(value);
const validBranch = value => typeof value === "string" && value.length <= 255 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..") && !value.startsWith("/") && !value.endsWith("/");
const validTime = value => typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
const validRevision = value => value === null || (typeof value === "string" && SHA.test(value));
const validScalar = value => value === null || typeof value === "boolean" ||
  (typeof value === "string" && value.length <= 512) ||
  (typeof value === "number" && Number.isFinite(value));

export function validateTaskEnvelope(input) {
  const keys = ["schema_version", "task_id", "actor", "action", "target", "constraints", "required_evidence", "created_at", "requested_authority", "status"];
  if (!exactKeys(input, keys)) return { ok: false, errors: ["TASK_SHAPE_INVALID"] };
  const errors = [];
  if (input.schema_version !== KRATT_SCHEMA_VERSION) errors.push("TASK_SCHEMA_UNSUPPORTED");
  if (!validId(input.task_id) || !validId(input.actor) || !validId(input.action)) errors.push("TASK_IDENTIFIER_INVALID");
  if (!exactKeys(input.target, ["resource_type", "resource_id"]) ||
      !validId(input.target.resource_type) || typeof input.target.resource_id !== "string" ||
      input.target.resource_id.length < 1 || input.target.resource_id.length > 512) errors.push("TASK_TARGET_INVALID");
  if (!scalarRecord(input.constraints, 32)) errors.push("TASK_CONSTRAINTS_INVALID");
  if (!denseArray(input.required_evidence, 32) ||
      input.required_evidence.some(item => !exactKeys(item, ["claim_type", "subject", "required", "revision"]) ||
        !EVIDENCE_CLAIMS.includes(item.claim_type) || !validId(item.subject) ||
        typeof item.required !== "boolean" || !validRevision(item.revision))) errors.push("TASK_EVIDENCE_REQUIREMENTS_INVALID");
  if (!validTime(input.created_at)) errors.push("TASK_TIMESTAMP_INVALID");
  if (!denseArray(input.requested_authority, 16) ||
      input.requested_authority.some(value => typeof value !== "string" || value.length > 128)) errors.push("TASK_REQUESTED_AUTHORITY_INVALID");
  if (!TASK_STATES.includes(input.status)) errors.push("TASK_STATUS_INVALID");
  return errors.length ? { ok: false, errors } : { ok: true, value: Object.freeze(structuredClone(input)) };
}

export function validateEvidenceRecord(input) {
  const keys = ["schema_version", "evidence_id", "subject", "claim_type", "source", "observed_at", "verification_method", "result", "artifact_digest", "metadata"];
  if (!exactKeys(input, keys)) return { ok: false, errors: ["EVIDENCE_SHAPE_INVALID"] };
  const errors = [];
  if (input.schema_version !== KRATT_SCHEMA_VERSION) errors.push("EVIDENCE_SCHEMA_UNSUPPORTED");
  if (!validId(input.evidence_id) || !validId(input.subject) || !EVIDENCE_CLAIMS.includes(input.claim_type)) errors.push("EVIDENCE_ID_OR_CLAIM_INVALID");
  if (!exactKeys(input.source, ["source_type", "source_id", "revision"]) ||
      !validId(input.source.source_type) || !validId(input.source.source_id) || !validRevision(input.source.revision)) errors.push("EVIDENCE_SOURCE_INVALID");
  if (!validTime(input.observed_at) || !validId(input.verification_method)) errors.push("EVIDENCE_TIME_OR_METHOD_INVALID");
  if (!EVIDENCE_RESULTS.includes(input.result)) errors.push("EVIDENCE_RESULT_INVALID");
  if (input.artifact_digest !== null && (typeof input.artifact_digest !== "string" || !DIGEST.test(input.artifact_digest))) errors.push("EVIDENCE_DIGEST_INVALID");
  if (!scalarRecord(input.metadata, 32)) errors.push("EVIDENCE_METADATA_INVALID");
  return errors.length ? { ok: false, errors } : { ok: true, value: Object.freeze(structuredClone(input)) };
}

/** Legacy display-level approval shape. It is not accepted as a cryptographic dispatch approval. */
export function validateApprovalArtifact(input) {
  const required = ["approval_id", "task_id", "actor", "provider", "operation", "target", "issued_at", "expires_at", "status", "nonce"];
  if (!exactKeys(input, required)) return { ok: false, errors: ["APPROVAL_SHAPE_INVALID"] };
  const errors = [];
  if (![input.approval_id, input.task_id, input.actor, input.provider, input.operation, input.nonce].every(validId)) errors.push("APPROVAL_IDENTIFIER_INVALID");
  if (!exactKeys(input.target, ["resource_type", "resource_id"]) || !validId(input.target.resource_type) ||
      typeof input.target.resource_id !== "string" || !input.target.resource_id || input.target.resource_id.length > 512) errors.push("APPROVAL_TARGET_INVALID");
  if (!validTime(input.issued_at) || !validTime(input.expires_at) || Date.parse(input.expires_at) <= Date.parse(input.issued_at)) errors.push("APPROVAL_TIME_INVALID");
  if (input.status !== "APPROVED") errors.push("APPROVAL_NOT_APPROVED");
  return errors.length ? { ok: false, errors } : { ok: true, value: Object.freeze(structuredClone(input)) };
}

export function validateTrustedContext(input) {
  const keys = ["schema_version", "authorities", "allowed_targets", "policies", "evaluated_at", "expires_at", "kill_switch"];
  if (!exactKeys(input, keys)) return { ok: false, errors: ["TRUSTED_CONTEXT_SHAPE_INVALID"] };
  const errors = [];
  if (input.schema_version !== KRATT_SCHEMA_VERSION) errors.push("TRUSTED_CONTEXT_SCHEMA_UNSUPPORTED");
  if (!denseArray(input.authorities, 32) || input.authorities.some(value => !validId(value))) errors.push("TRUSTED_AUTHORITIES_INVALID");
  if (!denseArray(input.allowed_targets, 64) ||
      input.allowed_targets.some(target => !exactKeys(target, ["resource_type", "resource_id"], ["branch", "path"]) ||
        !validId(target.resource_type) || typeof target.resource_id !== "string" || !target.resource_id || target.resource_id.length > 512 ||
        (target.branch !== undefined && !validBranch(target.branch)) ||
        (target.path !== undefined && (typeof target.path !== "string" || !target.path.startsWith("/") || target.path.split("/").includes(".."))))) {
    errors.push("TRUSTED_TARGETS_INVALID");
  }
  if (input.policies !== null && (!denseArray(input.policies, 64) ||
      input.policies.some(policy => !exactKeys(policy, ["action", "required_authority", "target_types", "side_effect_class"], ["approval_required", "approval_authority", "required_claims"]) ||
        !validId(policy.action) || !validId(policy.required_authority) || !denseArray(policy.target_types, 32) ||
        policy.target_types.length === 0 || policy.target_types.some(value => !validId(value)) ||
        new Set(policy.target_types).size !== policy.target_types.length || !SIDE_EFFECT_CLASSES.includes(policy.side_effect_class) ||
        (policy.approval_required !== undefined && typeof policy.approval_required !== "boolean") ||
        (policy.approval_authority !== undefined && !validId(policy.approval_authority)) ||
        (policy.required_claims !== undefined && (!denseArray(policy.required_claims, 16) ||
          policy.required_claims.some(value => !EVIDENCE_CLAIMS.includes(value)) || new Set(policy.required_claims).size !== policy.required_claims.length)) ||
        ((policy.approval_required === true || ["EXTERNAL_WRITE", "IRREVERSIBLE"].includes(policy.side_effect_class)) && !policy.approval_authority) ||
        (["LOCAL_WRITE", "EXTERNAL_WRITE", "IRREVERSIBLE"].includes(policy.side_effect_class) &&
          (!Array.isArray(policy.required_claims) || policy.required_claims.length === 0))))) {
    errors.push("TRUSTED_POLICIES_INVALID");
  }
  if (!validTime(input.evaluated_at) || !validTime(input.expires_at) || Date.parse(input.expires_at) <= Date.parse(input.evaluated_at)) errors.push("TRUSTED_CONTEXT_TIME_INVALID");
  if (typeof input.kill_switch !== "boolean") errors.push("TRUSTED_KILL_SWITCH_INVALID");
  return errors.length ? { ok: false, errors } : { ok: true, value: structuredClone(input) };
}
