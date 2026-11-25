/**
 * KRATT Integration Capability Registry.
 * Policy-only primitive: no authentication, credential resolution or I/O.
 */
export const INTEGRATION_STATES = Object.freeze([
  "DISCOVERED", "CONNECTED_UNVERIFIED", "VERIFIED_READ_ONLY",
  "WRITE_PENDING_APPROVAL", "WRITE_ENABLED", "DISABLED", "ERROR",
]);
export const OPERATION_CLASSES = Object.freeze({
  READ: "READ", EXTERNAL_WRITE: "EXTERNAL_WRITE", DESTRUCTIVE_WRITE: "DESTRUCTIVE_WRITE",
});
const SAFE_ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const SECRET_KEY = /(^|[_-])(secret|access.?token|refresh.?token|password|private.?key|authorization|client.?secret)$/i;
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const uniqueStrings = (v) => Array.isArray(v) &&
  v.every((x) => typeof x === "string" && x.length > 0) && new Set(v).size === v.length;
const includesAll = (set, required) => required.every((x) => set.includes(x));
const intersection = (...sets) => sets.length
  ? [...new Set(sets[0])].filter((x) => sets.slice(1).every((s) => s.includes(x))).sort()
  : [];
function hasSecretKey(value) {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || hasSecretKey(child));
}
function deny(code, reason) {
  return Object.freeze({ allowed: false, code, reason });
}
export function normalizeIntegrationDescriptor(input) {
  if (!isRecord(input)) throw new TypeError("descriptor must be an object");
  if (hasSecretKey(input)) throw new TypeError("secret-like fields are forbidden; use opaque credential references");
  const {
    integrationId, provider, accountRef, state, capabilities, resourceScopes,
    verifiedAt = null, evidenceRef = null, credentialRef = null, disabledReason = null,
  } = input;
  if (typeof integrationId !== "string" || !SAFE_ID.test(integrationId)) throw new TypeError("invalid integrationId");
  if (typeof provider !== "string" || !SAFE_ID.test(provider)) throw new TypeError("invalid provider");
  if (typeof accountRef !== "string" || accountRef.length < 2 || accountRef.length > 256) throw new TypeError("invalid accountRef");
  if (!INTEGRATION_STATES.includes(state)) throw new TypeError("unknown integration state");
  if (!isRecord(capabilities) || !uniqueStrings(capabilities.read) || !uniqueStrings(capabilities.write)) {
    throw new TypeError("read and write capabilities must be unique string arrays");
  }
  if (capabilities.read.some((x) => capabilities.write.includes(x))) throw new TypeError("read/write scope overlap");
  if (!isRecord(resourceScopes) || !uniqueStrings(resourceScopes.allow) || !uniqueStrings(resourceScopes.deny)) {
    throw new TypeError("resource allow/deny must be unique string arrays");
  }
  if (resourceScopes.allow.some((x) => resourceScopes.deny.includes(x))) throw new TypeError("resource scope overlap");
  if (verifiedAt !== null && (typeof verifiedAt !== "string" || Number.isNaN(Date.parse(verifiedAt)))) {
    throw new TypeError("invalid verifiedAt timestamp");
  }
  for (const [key, value] of [["evidenceRef", evidenceRef], ["credentialRef", credentialRef], ["disabledReason", disabledReason]]) {
    if (value !== null && typeof value !== "string") throw new TypeError(key + " must be a string reference or null");
  }
  return Object.freeze({
    integrationId, provider, accountRef, state,
    capabilities: Object.freeze({
      read: Object.freeze([...capabilities.read].sort()),
      write: Object.freeze([...capabilities.write].sort()),
    }),
    resourceScopes: Object.freeze({
      allow: Object.freeze([...resourceScopes.allow].sort()),
      deny: Object.freeze([...resourceScopes.deny].sort()),
    }),
    verifiedAt, evidenceRef, credentialRef, disabledReason,
  });
}
/** Inputs must be loaded by the trusted server composition root. */
export function intersectEffectiveScopes({ principal, agent, integration }) {
  for (const [name, value] of Object.entries({ principal, agent, integration })) {
    if (!uniqueStrings(value?.read) || !uniqueStrings(value?.write)) {
      throw new TypeError(name + " scopes must contain unique string arrays");
    }
  }
  return Object.freeze({
    read: Object.freeze(intersection(principal.read, agent.read, integration.read)),
    write: Object.freeze(intersection(principal.write, agent.write, integration.write)),
  });
}
/**
 * Evaluate a single operation. Approval.verified MUST come from a trusted
 * cryptographic verifier, never from caller-supplied request data.
 */
export function evaluateIntegrationOperation({
  integration, operation, request, effectiveScopes, approval = null, now = Date.now(),
}) {
  if (!integration || !operation || !request || !effectiveScopes) {
    return deny("MISSING_CONTEXT", "trusted policy context is incomplete");
  }
  let descriptor;
  try { descriptor = normalizeIntegrationDescriptor(integration); }
  catch (error) { return deny("INVALID_INTEGRATION", error.message); }
  if (descriptor.state === "DISABLED") return deny("INTEGRATION_DISABLED", "integration is disabled");
  if (descriptor.state === "ERROR") return deny("INTEGRATION_ERROR", "integration is in an error state");
  if (["DISCOVERED", "CONNECTED_UNVERIFIED"].includes(descriptor.state)) {
    return deny("INTEGRATION_UNVERIFIED", "integration is not verified");
  }
  if (!Object.values(OPERATION_CLASSES).includes(operation.class)) {
    return deny("UNKNOWN_OPERATION_CLASS", "operation class is not recognized");
  }
  if (typeof operation.operationId !== "string" || !SAFE_ID.test(operation.operationId) ||
      !uniqueStrings(operation.requiredScopes) || operation.requiredScopes.length === 0) {
    return deny("INVALID_OPERATION", "operation identifier or required scopes are invalid");
  }
  if (typeof request.requestId !== "string" || !SAFE_ID.test(request.requestId) ||
      typeof request.target !== "string" || request.target.length === 0 || request.target.length > 512) {
    return deny("INVALID_REQUEST", "request id or target is invalid");
  }
  if (request.provider !== descriptor.provider) return deny("PROVIDER_MISMATCH", "provider does not match descriptor");
  if (!uniqueStrings(effectiveScopes.read) || !uniqueStrings(effectiveScopes.write)) {
    return deny("INVALID_EFFECTIVE_SCOPES", "effective scopes are invalid");
  }
  if (descriptor.resourceScopes.deny.includes(request.target)) return deny("TARGET_DENIED", "target is explicitly denied");
  if (!descriptor.resourceScopes.allow.includes("*") &&
      !descriptor.resourceScopes.allow.includes(request.target)) {
    return deny("TARGET_OUT_OF_SCOPE", "target is outside integration scope");
  }
  if (operation.class === OPERATION_CLASSES.READ) {
    if (!["VERIFIED_READ_ONLY", "WRITE_ENABLED"].includes(descriptor.state)) {
      return deny("READ_NOT_VERIFIED", "integration is not in a verified state");
    }
    if (!includesAll(effectiveScopes.read, operation.requiredScopes) ||
        !includesAll(descriptor.capabilities.read, operation.requiredScopes)) {
      return deny("READ_SCOPE_MISSING", "effective read scope does not cover operation");
    }
    return Object.freeze({
      allowed: true, code: "READ_ALLOWED", operationId: operation.operationId,
      provider: descriptor.provider, target: request.target, requestId: request.requestId,
      sideEffect: "NONE",
    });
  }
  if (descriptor.state !== "WRITE_ENABLED") return deny("WRITE_NOT_ENABLED", "write is not explicitly enabled");
  if (!includesAll(effectiveScopes.write, operation.requiredScopes) ||
      !includesAll(descriptor.capabilities.write, operation.requiredScopes)) {
    return deny("WRITE_SCOPE_MISSING", "effective write scope does not cover operation");
  }
  if (!approval || approval.verified !== true) {
    return deny("APPROVAL_NOT_VERIFIED", "trusted approval verification is required");
  }
  if (approval.provider !== descriptor.provider || approval.operationId !== operation.operationId ||
      approval.target !== request.target || approval.requestId !== request.requestId) {
    return deny("APPROVAL_BINDING_MISMATCH", "approval is not bound to this exact request");
  }
  if (typeof approval.expiresAt !== "string" || Number.isNaN(Date.parse(approval.expiresAt))) {
    return deny("APPROVAL_EXPIRY_INVALID", "approval expiry is invalid");
  }
  if (Date.parse(approval.expiresAt) <= now) return deny("APPROVAL_EXPIRED", "approval has expired");
  if (operation.class === OPERATION_CLASSES.DESTRUCTIVE_WRITE && approval.destructive !== true) {
    return deny("DESTRUCTIVE_APPROVAL_REQUIRED", "destructive approval is required");
  }
  return Object.freeze({
    allowed: true, code: "WRITE_ALLOWED", operationId: operation.operationId,
    provider: descriptor.provider, target: request.target, requestId: request.requestId,
    approvalRef: typeof approval.approvalRef === "string" ? approval.approvalRef : null,
    sideEffect: operation.class,
  });
}
export function toCapabilityAuditRecord(decision, { integrationId, actorRef, occurredAt = new Date().toISOString() }) {
  if (!decision || typeof decision.allowed !== "boolean") throw new TypeError("invalid decision");
  if (typeof integrationId !== "string" || typeof actorRef !== "string") throw new TypeError("audit identity refs required");
  const record = Object.freeze({
    schemaVersion: 1, eventType: "integration.capability.decision", occurredAt,
    integrationId, actorRef, allowed: decision.allowed, code: decision.code,
    operationId: decision.operationId ?? null, provider: decision.provider ?? null,
    target: decision.target ?? null, requestId: decision.requestId ?? null,
    approvalRef: decision.approvalRef ?? null, sideEffect: decision.sideEffect ?? null,
  });
  if (hasSecretKey(record)) throw new TypeError("audit record contains secret-like data");
  return record;
}
