import { createHash } from "node:crypto";
import {
  verifyApprovalForRequest,
} from "./approval-evidence.mjs";
import {
  evaluateIntegrationOperation,
  intersectEffectiveScopes,
  OPERATION_CLASSES,
} from "./integration-capability-registry.mjs";
import { resolveAdapterOperation } from "./adapter-contract.mjs";

const SAFE_REF = /^[a-z][a-z0-9._:-]{1,127}$/;
const SAFE_OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = [
  "adapterId", "requestId", "principalRef", "agentRef", "target",
  "operationId", "requestDigest", "destructive",
];
const INPUT_KEYS = ["request", "approvalEnvelope"];
const SCOPE_KEYS = ["read", "write"];
const VERIFIED_GRANTS = new WeakSet();

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataKeys(value, keys) {
  try {
    if (!isPlain(value)) return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length ||
        own.some((key) => typeof key !== "string" || !keys.includes(key))) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && "value" in descriptor && descriptor.enumerable);
    });
  } catch {
    return false;
  }
}

function safeRef(value) {
  return typeof value === "string" && SAFE_REF.test(value);
}

function safeScopeList(value) {
  return Array.isArray(value) &&
    value.length <= 128 &&
    value.every((entry) => typeof entry === "string" &&
      entry.length > 0 && entry.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(entry)) &&
    new Set(value).size === value.length;
}

function validateScopePair(value) {
  return exactDataKeys(value, SCOPE_KEYS) &&
    safeScopeList(value.read) && safeScopeList(value.write);
}

function validateTrustedContext(value, request) {
  if (!exactDataKeys(value, ["principal", "agent", "integration"])) return null;
  if (!exactDataKeys(value.principal, ["ref", "scopes"]) ||
      !exactDataKeys(value.agent, ["ref", "scopes"]) ||
      !exactDataKeys(value.integration, ["accountRef", "scopes", "resourceScopes"])) return null;
  if (!safeRef(value.principal.ref) || !safeRef(value.agent.ref) ||
      value.principal.ref !== request.principalRef ||
      value.agent.ref !== request.agentRef) return null;
  if (!validateScopePair(value.principal.scopes) ||
      !validateScopePair(value.agent.scopes) ||
      !validateScopePair(value.integration.scopes)) return null;
  if (!exactDataKeys(value.integration.resourceScopes, ["allow", "deny"]) ||
      !safeScopeList(value.integration.resourceScopes.allow) ||
      !safeScopeList(value.integration.resourceScopes.deny)) return null;
  if (typeof value.integration.accountRef !== "string" ||
      value.integration.accountRef.length < 2 || value.integration.accountRef.length > 256) return null;
  if (value.integration.resourceScopes.allow.some((x) =>
      value.integration.resourceScopes.deny.includes(x))) return null;
  return value;
}

function capabilityRef(contract, id) {
  const capability = contract.capabilities.find((item) => item.id === id);
  return capability ? capability.id + "@" + capability.version : null;
}

function deriveDescriptor(record, trustedContext) {
  const read = [];
  const write = [];
  for (const operation of record.contract.operations) {
    const destination = operation.class === "READ" ? read : write;
    for (const capabilityId of operation.requiredCapabilities) {
      const reference = capabilityRef(record.contract, capabilityId);
      if (!reference) return null;
      if (!destination.includes(reference)) destination.push(reference);
    }
  }
  if (read.some((scope) => write.includes(scope))) return null;
  return {
    integrationId: record.adapterId,
    provider: record.provider,
    accountRef: trustedContext.integration.accountRef,
    state: record.integration.state,
    capabilities: { read, write },
    resourceScopes: trustedContext.integration.resourceScopes,
    verifiedAt: record.readOnlyAttestation?.verifiedAt ?? null,
    evidenceRef: record.readOnlyAttestation?.evidenceRef ?? record.sourceProvenance.evidenceRef,
    credentialRef: null,
  };
}

function mapOperationClass(value) {
  if (value === "READ") return OPERATION_CLASSES.READ;
  if (value === "EXTERNAL_WRITE") return OPERATION_CLASSES.EXTERNAL_WRITE;
  if (value === "DESTRUCTIVE_WRITE") return OPERATION_CLASSES.DESTRUCTIVE_WRITE;
  return null;
}

function stableRequest(input) {
  if (!exactDataKeys(input, REQUEST_KEYS)) return null;
  if (!safeRef(input.adapterId) || !safeRef(input.requestId) ||
      !safeRef(input.principalRef) || !safeRef(input.agentRef) ||
      !safeRef(input.operationId) || typeof input.target !== "string" ||
      input.target.length < 1 || input.target.length > 512 ||
      typeof input.requestDigest !== "string" || !DIGEST.test(input.requestDigest) ||
      typeof input.destructive !== "boolean") return null;
  return Object.freeze({ ...input });
}

function nowValue(clock) {
  let value;
  try { value = clock(); } catch { return null; }
  const milliseconds = value instanceof Date ? value.getTime() : value;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function resultError(code) {
  return Object.freeze({ ok: false, allowed: false, code });
}

function makeAuditEvent({ request, record, decision, occurredAt, approvalId = null }) {
  const body = {
    schema: "3XT-ADAPTER-AUTH-AUDIT",
    schemaVersion: 1,
    eventType: decision.allowed ? "adapter.operation.allowed" : "adapter.operation.denied",
    adapterId: record?.adapterId ?? request.adapterId,
    provider: record?.provider ?? null,
    registrationRevision: record?.revision ?? null,
    contractDigest: record?.contractDigest ?? null,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    principalRef: request.principalRef,
    agentRef: request.agentRef,
    operationId: request.operationId,
    target: request.target,
    decisionCode: decision.code,
    sideEffect: decision.sideEffect ?? "NONE",
    approvalId,
    occurredAt,
  };
  return Object.freeze({
    eventId: "adapter-auth:" + digest(body),
    ...body,
  });
}

function mintGrant(fields) {
  const grant = Object.freeze({ ...fields });
  VERIFIED_GRANTS.add(grant);
  return grant;
}

/** A verifier for the WP-04.4 execution gate; arbitrary decision objects are rejected. */
export function isAuthorizedAdapterInvocation(value) {
  return Boolean(value && VERIFIED_GRANTS.has(value) && value.code === "ADAPTER_OPERATION_AUTHORIZED");
}

/**
 * Host-composed adapter operation authorization.
 *
 * Principal, agent and integration scopes must come from a trusted server-side
 * loader. Manifest declarations are intersected with those grants. A write
 * requires a request-digest-bound cryptographic approval and one-time ledger
 * consumption. This module issues no provider calls and no credentials.
 */
export function createAdapterAuthorizationRuntime({
  registrationRuntime,
  trustedContextLoader,
  approvalVerifier,
  approvalLedger,
  auditStore,
  now,
  maxReadGrantMs = 30_000,
  maxApprovalLifetimeMs = 900_000,
} = {}) {
  if (!registrationRuntime || typeof registrationRuntime.get !== "function") {
    throw new TypeError("ADAPTER_REGISTRATION_RUNTIME_REQUIRED");
  }
  if (!trustedContextLoader || typeof trustedContextLoader.load !== "function") {
    throw new TypeError("TRUSTED_CONTEXT_LOADER_REQUIRED");
  }
  if (!approvalVerifier || typeof approvalVerifier.verify !== "function") {
    throw new TypeError("TRUSTED_APPROVAL_VERIFIER_REQUIRED");
  }
  if (!approvalLedger || typeof approvalLedger.consume !== "function") {
    throw new TypeError("DURABLE_APPROVAL_LEDGER_REQUIRED");
  }
  if (!auditStore || typeof auditStore.appendDecision !== "function") {
    throw new TypeError("APPEND_ONLY_AUTH_AUDIT_STORE_REQUIRED");
  }
  if (typeof now !== "function" || !Number.isSafeInteger(maxReadGrantMs) ||
      maxReadGrantMs < 1 || maxReadGrantMs > 120_000 ||
      !Number.isSafeInteger(maxApprovalLifetimeMs) || maxApprovalLifetimeMs < 1) {
    throw new TypeError("AUTHORIZATION_CLOCK_OR_LIMIT_INVALID");
  }

  async function appendAudit(request, record, decision, occurredAt, approvalId = null) {
    const event = makeAuditEvent({ request, record, decision, occurredAt, approvalId });
    let result;
    try { result = await auditStore.appendDecision(event); } catch { result = null; }
    return result === "APPENDED";
  }

  async function deny(request, record, code, timestamp = null) {
    const denial = Object.freeze({ allowed: false, code, sideEffect: "NONE" });
    const occurredAt = timestamp === null ? nowValue(now) : timestamp;
    if (request && occurredAt !== null &&
        !(await appendAudit(request, record, denial, new Date(occurredAt).toISOString()))) {
      return resultError("AUTH_AUDIT_APPEND_FAILED");
    }
    return resultError(code);
  }

  async function authorize(input = {}) {
    if (!exactDataKeys(input, INPUT_KEYS)) return resultError("AUTHORIZATION_INPUT_INVALID");
    const request = stableRequest(input.request);
    if (!request) return resultError("AUTHORIZATION_REQUEST_INVALID");
    const timestamp = nowValue(now);
    if (timestamp === null) return resultError("TRUSTED_AUTHORIZATION_CLOCK_UNAVAILABLE");

    let fetched;
    try { fetched = await registrationRuntime.get(request.adapterId); }
    catch { return deny(request, null, "ADAPTER_REGISTRATION_UNAVAILABLE", timestamp); }
    if (!fetched?.ok || !fetched.record) return deny(request, null, "ADAPTER_NOT_REGISTERED", timestamp);
    const record = fetched.record;
    if (record.adapterId !== request.adapterId) return deny(request, record, "ADAPTER_IDENTITY_MISMATCH", timestamp);

    const resolved = resolveAdapterOperation(record.contract, request.operationId);
    if (!resolved.ok) return deny(request, record, "ADAPTER_OPERATION_NOT_DECLARED", timestamp);
    const operationClass = mapOperationClass(resolved.operation.class);
    if (!operationClass) return deny(request, record, "ADAPTER_OPERATION_CLASS_INVALID", timestamp);
    const requiredScopes = resolved.operation.requiredScopes.map((id) =>
      capabilityRef(record.contract, id));
    if (requiredScopes.some((scope) => typeof scope !== "string")) {
      return deny(request, record, "ADAPTER_CAPABILITY_BINDING_INVALID", timestamp);
    }

    let trusted;
    try {
      trusted = await trustedContextLoader.load(Object.freeze({
        adapterId: record.adapterId,
        principalRef: request.principalRef,
        agentRef: request.agentRef,
        requestId: request.requestId,
      }));
    } catch {
      return deny(request, record, "TRUSTED_AUTHORIZATION_CONTEXT_UNAVAILABLE", timestamp);
    }
    trusted = validateTrustedContext(trusted, request);
    if (!trusted) return deny(request, record, "TRUSTED_AUTHORIZATION_CONTEXT_INVALID", timestamp);

    let effectiveScopes;
    try {
      effectiveScopes = intersectEffectiveScopes({
        principal: trusted.principal.scopes,
        agent: trusted.agent.scopes,
        integration: trusted.integration.scopes,
      });
    } catch {
      return deny(request, record, "EFFECTIVE_SCOPE_INTERSECTION_FAILED", timestamp);
    }

    const descriptor = deriveDescriptor(record, trusted);
    if (!descriptor) return deny(request, record, "ADAPTER_CAPABILITY_DESCRIPTOR_INVALID", timestamp);
    const policyOperation = {
      operationId: resolved.operation.operationId,
      class: operationClass,
      requiredScopes,
    };
    const policyRequest = {
      requestId: request.requestId,
      provider: record.provider,
      target: request.target,
    };

    let verifiedApproval = null;
    let approvalForPolicy = null;
    const isWrite = operationClass !== OPERATION_CLASSES.READ;
    if (isWrite && descriptor.state === "WRITE_ENABLED") {
      if (input.approvalEnvelope === null || input.approvalEnvelope === undefined) {
        return deny(request, record, "REQUEST_BOUND_APPROVAL_REQUIRED", timestamp);
      }
      verifiedApproval = await verifyApprovalForRequest({
        envelope: input.approvalEnvelope,
        verifier: approvalVerifier,
        request: {
          requestId: request.requestId,
          provider: record.provider,
          operationId: request.operationId,
          target: request.target,
          requestDigest: request.requestDigest,
          destructive: request.destructive,
        },
        principalRef: request.principalRef,
        agentRef: request.agentRef,
        requiredScopes,
        now: timestamp,
        maxLifetimeMs: maxApprovalLifetimeMs,
      });
      if (verifiedApproval.code !== "APPROVAL_VERIFIED") {
        return deny(request, record, verifiedApproval.code, timestamp);
      }
      approvalForPolicy = {
        verified: true,
        provider: verifiedApproval.provider,
        operationId: verifiedApproval.operationId,
        target: verifiedApproval.target,
        requestId: verifiedApproval.requestId,
        expiresAt: verifiedApproval.expiresAt,
        destructive: verifiedApproval.destructive,
        approvalRef: verifiedApproval.approvalId,
      };
    }

    const policyDecision = evaluateIntegrationOperation({
      integration: descriptor,
      operation: policyOperation,
      request: policyRequest,
      effectiveScopes,
      approval: approvalForPolicy,
      now: timestamp,
    });
    if (!policyDecision.allowed) return deny(request, record, policyDecision.code, timestamp);

    let approvalId = null;
    if (isWrite) {
      if (!verifiedApproval) return deny(request, record, "REQUEST_BOUND_APPROVAL_REQUIRED", timestamp);
      let consumed;
      try {
        consumed = await approvalLedger.consume(verifiedApproval, { now: timestamp });
      } catch {
        consumed = null;
      }
      if (!consumed || consumed.allowed !== true || consumed.code !== "APPROVAL_CONSUMED") {
        return deny(request, record, consumed?.code ?? "APPROVAL_CONSUMPTION_FAILED", timestamp);
      }
      approvalId = verifiedApproval.approvalId;
    }

    if (!(await appendAudit(request, record, policyDecision, new Date(timestamp).toISOString(), approvalId))) {
      return resultError("AUTH_AUDIT_APPEND_FAILED");
    }

    const grantExpiresAt = isWrite
      ? verifiedApproval.expiresAt
      : new Date(timestamp + maxReadGrantMs).toISOString();
    return mintGrant({
      ok: true,
      allowed: true,
      code: "ADAPTER_OPERATION_AUTHORIZED",
      adapterId: record.adapterId,
      provider: record.provider,
      registrationRevision: record.revision,
      contractDigest: record.contractDigest,
      artifactDigest: record.contract.implementation.artifactDigest,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      principalRef: request.principalRef,
      agentRef: request.agentRef,
      operationId: request.operationId,
      operationClass: resolved.operation.class,
      target: request.target,
      requiredScopes: Object.freeze(requiredScopes),
      grantExpiresAt,
      approvalId,
    });
  }

  return Object.freeze({ authorize });
}
