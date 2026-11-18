/**
 * KRATT integration lifecycle and request-bound operation gate.
 *
 * Pure policy helpers only: no network I/O, credentials, persistence, or
 * external side effects. Callers must supply the trusted current time and
 * the approval returned by a server-owned approval verifier.
 */

export const INTEGRATION_STATES = Object.freeze([
  "DISCOVERED",
  "CONNECTED_UNVERIFIED",
  "VERIFIED_READ_ONLY",
  "WRITE_PENDING_APPROVAL",
  "WRITE_ENABLED",
  "DISABLED",
  "ERROR",
]);

const STATE_SET = new Set(INTEGRATION_STATES);
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const ACTION = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,7}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const TRANSITIONS = Object.freeze({
  DISCOVERED: ["CONNECTED_UNVERIFIED", "DISABLED", "ERROR"],
  CONNECTED_UNVERIFIED: ["VERIFIED_READ_ONLY", "DISABLED", "ERROR"],
  VERIFIED_READ_ONLY: ["WRITE_PENDING_APPROVAL", "DISABLED", "ERROR"],
  WRITE_PENDING_APPROVAL: ["VERIFIED_READ_ONLY", "WRITE_ENABLED", "DISABLED", "ERROR"],
  WRITE_ENABLED: ["VERIFIED_READ_ONLY", "DISABLED", "ERROR"],
  DISABLED: [],
  ERROR: ["CONNECTED_UNVERIFIED", "DISABLED"],
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactDataObject(value, keys) {
  if (!isPlainObject(value)) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function validText(value, pattern = ID) {
  return typeof value === "string" && pattern.test(value);
}

function validUtc(value) {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function validOperationList(value) {
  return Array.isArray(value) && value.length <= 64 &&
    value.every((item) => validText(item, ACTION)) &&
    new Set(value).size === value.length;
}

export function validateIntegrationRecord(record) {
  const errors = [];
  const keys = ["integration_id", "name", "state", "read_operations", "write_operations"];
  if (!exactDataObject(record, keys)) return { ok: false, errors: ["INTEGRATION_SHAPE_INVALID"] };
  if (!validText(record.integration_id)) errors.push("INTEGRATION_ID_INVALID");
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > 160) errors.push("INTEGRATION_NAME_INVALID");
  if (!STATE_SET.has(record.state)) errors.push("INTEGRATION_STATE_INVALID");
  if (!validOperationList(record.read_operations)) errors.push("INTEGRATION_READ_OPERATIONS_INVALID");
  if (!validOperationList(record.write_operations)) errors.push("INTEGRATION_WRITE_OPERATIONS_INVALID");
  if (Array.isArray(record.read_operations) && Array.isArray(record.write_operations)) {
    const overlap = record.read_operations.some((operation) => record.write_operations.includes(operation));
    if (overlap) errors.push("INTEGRATION_OPERATION_MODE_OVERLAP");
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function transitionIntegrationState(record, nextState) {
  const validation = validateIntegrationRecord(record);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  if (!STATE_SET.has(nextState)) return { ok: false, errors: ["INTEGRATION_STATE_INVALID"] };
  if (!TRANSITIONS[record.state].includes(nextState)) {
    return { ok: false, errors: ["INTEGRATION_TRANSITION_DENIED"] };
  }
  return { ok: true, value: Object.freeze({ ...record, state: nextState }) };
}

function requestShapeValid(request) {
  return exactDataObject(request, ["request_id", "principal", "operation", "mode", "scope", "args_digest"]) &&
    validText(request.request_id) &&
    validText(request.principal) &&
    validText(request.operation, ACTION) &&
    (request.mode === "read" || request.mode === "write") &&
    validText(request.scope) &&
    typeof request.args_digest === "string" && SHA256.test(request.args_digest);
}

function approvalShapeValid(approval) {
  return exactDataObject(approval, [
    "request_id", "integration_id", "principal", "operation", "scope",
    "args_digest", "status", "expires_at",
  ]) &&
    validText(approval.request_id) &&
    validText(approval.integration_id) &&
    validText(approval.principal) &&
    validText(approval.operation, ACTION) &&
    validText(approval.scope) &&
    typeof approval.args_digest === "string" && SHA256.test(approval.args_digest) &&
    approval.status === "approved" &&
    validUtc(approval.expires_at);
}

/**
 * Fail-closed operation gate. "now" is an explicit trusted epoch-millisecond
 * input from the caller; this module never reads the host clock.
 */
export function authorizeIntegrationOperation({
  integration,
  request,
  approval = null,
  now,
} = {}) {
  const integrationValidation = validateIntegrationRecord(integration);
  if (!integrationValidation.ok) return { allowed: false, reason: integrationValidation.errors[0] };
  if (!requestShapeValid(request)) return { allowed: false, reason: "INTEGRATION_REQUEST_INVALID" };
  if (!Number.isFinite(now) || now < 0) return { allowed: false, reason: "TRUSTED_TIME_REQUIRED" };

  if (integration.state === "DISABLED") return { allowed: false, reason: "INTEGRATION_DISABLED" };
  if (integration.state === "ERROR") return { allowed: false, reason: "INTEGRATION_ERROR" };
  if (integration.state === "DISCOVERED" || integration.state === "CONNECTED_UNVERIFIED") {
    return { allowed: false, reason: "INTEGRATION_NOT_VERIFIED" };
  }

  if (request.mode === "read") {
    if (!["VERIFIED_READ_ONLY", "WRITE_PENDING_APPROVAL", "WRITE_ENABLED"].includes(integration.state)) {
      return { allowed: false, reason: "READ_NOT_ENABLED" };
    }
    if (!integration.read_operations.includes(request.operation)) {
      return { allowed: false, reason: "READ_OPERATION_OUT_OF_SCOPE" };
    }
    return { allowed: true, decision: "ALLOW_READ_ONLY", approval_required: false };
  }

  if (request.mode !== "write") return { allowed: false, reason: "OPERATION_MODE_INVALID" };
  if (integration.state !== "WRITE_ENABLED") {
    return { allowed: false, reason: "WRITE_NOT_ENABLED" };
  }
  if (!integration.write_operations.includes(request.operation)) {
    return { allowed: false, reason: "WRITE_OPERATION_OUT_OF_SCOPE" };
  }
  if (!approvalShapeValid(approval)) return { allowed: false, reason: "REQUEST_BOUND_APPROVAL_REQUIRED" };

  const matches =
    approval.request_id === request.request_id &&
    approval.integration_id === integration.integration_id &&
    approval.principal === request.principal &&
    approval.operation === request.operation &&
    approval.scope === request.scope &&
    approval.args_digest === request.args_digest;

  if (!matches) return { allowed: false, reason: "APPROVAL_BINDING_MISMATCH" };
  if (Date.parse(approval.expires_at) <= now) return { allowed: false, reason: "APPROVAL_EXPIRED" };

  return { allowed: true, decision: "ALLOW_APPROVED_WRITE", approval_required: true };
}

export function listAllowedTransitions(state) {
  return STATE_SET.has(state) ? [...TRANSITIONS[state]] : [];
}
