import { createHash, randomUUID } from "node:crypto";
import { isAuthorizedAdapterInvocation } from "./adapter-authorization.mjs";
import { resolveAdapterOperation } from "./adapter-contract.mjs";

const SAFE_REF = /^[a-z][a-z0-9._:-]{1,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = [
  "adapterId", "requestId", "principalRef", "agentRef", "target",
  "operationId", "requestDigest", "destructive",
];
const INPUT_KEYS = ["request", "approvalEnvelope"];
const SUPERVISOR_KEYS = [
  "supervisorRef", "isolationClass", "policyDigest",
  "networkPolicy", "filesystemPolicy", "credentialPolicy",
];
const RECEIPT_KEYS = ["verified", "evidenceRef", "verifierRef"];
const RESULT_KEYS = [
  "status", "workerRef", "resultRef", "resultDigest",
  "finishedAt", "reasonCode",
];
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESULT_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"]);
const REQUIRED_ISOLATION = "OS_PROCESS_CONTAINER";

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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

function nowValue(clock) {
  let value;
  try { value = clock(); } catch { return null; }
  const milliseconds = value instanceof Date ? value.getTime() : value;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function stableRequest(value) {
  if (!exactDataKeys(value, REQUEST_KEYS)) return null;
  if (!safeRef(value.adapterId) || !safeRef(value.requestId) ||
      !safeRef(value.principalRef) || !safeRef(value.agentRef) ||
      !safeRef(value.operationId) || typeof value.target !== "string" ||
      value.target.length < 1 || value.target.length > 512 ||
      typeof value.requestDigest !== "string" || !DIGEST.test(value.requestDigest) ||
      typeof value.destructive !== "boolean") return null;
  return Object.freeze({ ...value });
}

function normalizeSupervisor(value) {
  if (!exactDataKeys(value, SUPERVISOR_KEYS)) return null;
  if (!safeRef(value.supervisorRef) ||
      value.isolationClass !== REQUIRED_ISOLATION ||
      typeof value.policyDigest !== "string" || !DIGEST.test(value.policyDigest) ||
      value.networkPolicy !== "PROVIDER_ALLOWLIST_ONLY" ||
      value.filesystemPolicy !== "READ_ONLY_ARTIFACT_AND_EPHEMERAL_TMP" ||
      value.credentialPolicy !== "NO_RAW_SECRETS") return null;
  return Object.freeze({ ...value });
}

function normalizeVerifierReceipt(value) {
  if (!exactDataKeys(value, RECEIPT_KEYS) ||
      value.verified !== true || !safeRef(value.evidenceRef) ||
      !safeRef(value.verifierRef)) return null;
  return Object.freeze({
    evidenceRef: value.evidenceRef,
    verifierRef: value.verifierRef,
  });
}

function normalizeWorkerResult(value) {
  if (!exactDataKeys(value, RESULT_KEYS) || !RESULT_STATES.has(value.status)) return null;
  if (!safeRef(value.workerRef)) return null;
  if (value.status === "COMPLETED") {
    if (!safeRef(value.resultRef) || typeof value.resultDigest !== "string" ||
        !DIGEST.test(value.resultDigest) || value.reasonCode !== null) return null;
  } else if (value.resultRef !== null || value.resultDigest !== null ||
      typeof value.reasonCode !== "string" || !REASON.test(value.reasonCode)) {
    return null;
  }
  if (typeof value.finishedAt !== "string" || !Number.isFinite(Date.parse(value.finishedAt))) return null;
  return Object.freeze({ ...value });
}

function makeEvent({
  eventType, invocationId, request, grant, record,
  occurredAt, result = null, reasonCode = null, isolationEvidenceRef = null,
}) {
  const body = {
    schema: "3XT-ADAPTER-EXECUTION-AUDIT",
    schemaVersion: 1,
    eventType,
    invocationId,
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
    target: request.target,
    authorizationGrantExpiresAt: grant.grantExpiresAt,
    isolationEvidenceRef,
    resultStatus: result?.status ?? null,
    resultRef: result?.resultRef ?? null,
    resultDigest: result?.resultDigest ?? null,
    reasonCode,
    occurredAt,
  };
  return Object.freeze({ eventId: "adapter-exec:" + digest(body), ...body });
}

function deny(code) {
  return Object.freeze({ ok: false, allowed: false, code });
}

/**
 * Build a read-only process invocation from a branded WP-04.3 authorization.
 * The platform supervisor and isolation verifier are trusted host dependencies.
 * This module never imports dynamic code, resolves credentials, or issues writes.
 */
export function createAdapterExecutionRuntime({
  authorizationRuntime,
  registrationRuntime,
  workerSupervisor,
  isolationVerifier,
  executionFence,
  executionStore,
  now,
  maxExecutionMs = 30_000,
  maxOutputBytes = 262_144,
  memoryLimitMb = 128,
} = {}) {
  if (!authorizationRuntime || typeof authorizationRuntime.authorize !== "function") {
    throw new TypeError("ADAPTER_AUTHORIZATION_RUNTIME_REQUIRED");
  }
  if (!registrationRuntime || typeof registrationRuntime.get !== "function") {
    throw new TypeError("ADAPTER_REGISTRATION_RUNTIME_REQUIRED");
  }
  if (!workerSupervisor ||
      typeof workerSupervisor.describeIsolation !== "function" ||
      typeof workerSupervisor.runInRestrictedProcess !== "function") {
    throw new TypeError("RESTRICTED_PROCESS_SUPERVISOR_REQUIRED");
  }
  if (!isolationVerifier || typeof isolationVerifier.verify !== "function") {
    throw new TypeError("TRUSTED_ISOLATION_VERIFIER_REQUIRED");
  }
  if (!executionFence || typeof executionFence.check !== "function") {
    throw new TypeError("CURRENT_EXECUTION_FENCE_REQUIRED");
  }
  if (!executionStore ||
      typeof executionStore.startWithAudit !== "function" ||
      typeof executionStore.finishWithAudit !== "function") {
    throw new TypeError("DURABLE_EXECUTION_STORE_REQUIRED");
  }
  if (typeof now !== "function" ||
      !Number.isSafeInteger(maxExecutionMs) || maxExecutionMs < 100 ||
      maxExecutionMs > 120_000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 ||
      maxOutputBytes > 1_048_576 ||
      !Number.isSafeInteger(memoryLimitMb) || memoryLimitMb < 64 ||
      memoryLimitMb > 512) {
    throw new TypeError("EXECUTION_LIMITS_INVALID");
  }

  async function fence(request, grant, record, phase) {
    let checked;
    try {
      checked = await executionFence.check(Object.freeze({
        phase,
        adapterId: record.adapterId,
        registrationRevision: record.revision,
        contractDigest: record.contractDigest,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        principalRef: request.principalRef,
        agentRef: request.agentRef,
        grantExpiresAt: grant.grantExpiresAt,
      }));
    } catch {
      return false;
    }
    return checked === true || (isPlain(checked) && checked.allowed === true);
  }

  async function execute(input = {}) {
    if (!exactDataKeys(input, INPUT_KEYS)) return deny("EXECUTION_INPUT_INVALID");
    const request = stableRequest(input.request);
    if (!request) return deny("EXECUTION_REQUEST_INVALID");

    const timestamp = nowValue(now);
    if (timestamp === null) return deny("TRUSTED_EXECUTION_CLOCK_UNAVAILABLE");

    let grant;
    try {
      grant = await authorizationRuntime.authorize({
        request,
        approvalEnvelope: input.approvalEnvelope ?? null,
      });
    } catch {
      return deny("ADAPTER_AUTHORIZATION_FAILED");
    }
    if (grant && grant.allowed === false &&
        typeof grant.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(grant.code)) {
      return deny(grant.code);
    }
    if (!isAuthorizedAdapterInvocation(grant) ||
        grant.adapterId !== request.adapterId ||
        grant.requestId !== request.requestId ||
        grant.requestDigest !== request.requestDigest ||
        grant.principalRef !== request.principalRef ||
        grant.agentRef !== request.agentRef ||
        grant.operationId !== request.operationId ||
        grant.target !== request.target ||
        grant.code !== "ADAPTER_OPERATION_AUTHORIZED") {
      return deny("AUTHORIZATION_GRANT_UNTRUSTED_OR_MISMATCHED");
    }
    const expires = Date.parse(grant.grantExpiresAt);
    if (!Number.isFinite(expires) || expires <= timestamp) return deny("AUTHORIZATION_GRANT_EXPIRED");

    let fetched;
    try { fetched = await registrationRuntime.get(request.adapterId); }
    catch { return deny("ADAPTER_REGISTRATION_UNAVAILABLE"); }
    if (!fetched?.ok || !fetched.record) return deny("ADAPTER_NOT_REGISTERED");
    const record = fetched.record;
    if (record.adapterId !== grant.adapterId ||
        record.provider !== grant.provider ||
        record.revision !== grant.registrationRevision ||
        record.contractDigest !== grant.contractDigest ||
        record.contract.implementation.artifactDigest !== grant.artifactDigest) {
      return deny("REGISTRATION_CHANGED_AFTER_AUTHORIZATION");
    }
    if (record.integration.state !== "VERIFIED_READ_ONLY") {
      return deny("EXECUTION_REQUIRES_VERIFIED_READ_ONLY_REGISTRATION");
    }

    const resolved = resolveAdapterOperation(record.contract, request.operationId);
    if (!resolved.ok || resolved.operation.class !== "READ" ||
        grant.operationClass !== "READ") {
      return deny("WRITE_EXECUTION_DISABLED");
    }
    if (record.contract.implementation.executionMode !== "PROCESS_ISOLATED") {
      return deny("PROCESS_ISOLATION_REQUIRED");
    }

    let supervisor;
    try { supervisor = await workerSupervisor.describeIsolation(); }
    catch { return deny("SUPERVISOR_DESCRIPTION_UNAVAILABLE"); }
    supervisor = normalizeSupervisor(supervisor);
    if (!supervisor) return deny("SUPERVISOR_ISOLATION_PROFILE_INVALID");

    let isolationReceipt;
    try {
      isolationReceipt = await isolationVerifier.verify(Object.freeze({
        supervisor,
        adapterId: record.adapterId,
        provider: record.provider,
        contractDigest: record.contractDigest,
        artifactDigest: record.contract.implementation.artifactDigest,
        operationId: resolved.operation.operationId,
        operationClass: resolved.operation.class,
        requiredScopes: grant.requiredScopes,
      }));
    } catch {
      return deny("ISOLATION_VERIFIER_FAILED");
    }
    const isolation = normalizeVerifierReceipt(isolationReceipt);
    if (!isolation) return deny("PROCESS_ISOLATION_UNVERIFIED");

    const timeoutMs = Math.min(resolved.operation.timeoutMs, maxExecutionMs);
    const invocationId = "invocation:" + randomUUID();
    const occurredAt = new Date(timestamp).toISOString();
    const invocation = Object.freeze({
      schema: "3XT-ADAPTER-INVOCATION",
      schemaVersion: 1,
      invocationId,
      adapter: Object.freeze({
        adapterId: record.adapterId,
        provider: record.provider,
        source: Object.freeze({
          repository: record.contract.implementation.source.repository,
          revision: record.contract.implementation.source.revision,
          path: record.contract.implementation.source.path,
          artifactDigest: record.contract.implementation.artifactDigest,
        }),
        contractDigest: record.contractDigest,
      }),
      operation: Object.freeze({
        operationId: resolved.operation.operationId,
        class: "READ",
        requiredCapabilities: Object.freeze([...resolved.operation.requiredScopes]),
        timeoutMs,
        maxAttempts: 1,
      }),
      request: Object.freeze({
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        target: request.target,
      }),
      authorization: Object.freeze({
        principalRef: grant.principalRef,
        agentRef: grant.agentRef,
        grantExpiresAt: grant.grantExpiresAt,
        requiredScopes: Object.freeze([...grant.requiredScopes]),
      }),
      isolation: Object.freeze({
        supervisorRef: supervisor.supervisorRef,
        isolationClass: supervisor.isolationClass,
        policyDigest: supervisor.policyDigest,
        evidenceRef: isolation.evidenceRef,
        verifierRef: isolation.verifierRef,
      }),
      limits: Object.freeze({
        timeoutMs,
        memoryLimitMb,
        maxOutputBytes,
        networkPolicy: supervisor.networkPolicy,
        filesystemPolicy: supervisor.filesystemPolicy,
        credentialPolicy: supervisor.credentialPolicy,
      }),
    });

    const startTime = nowValue(now);
    if (startTime === null) return deny("TRUSTED_EXECUTION_CLOCK_UNAVAILABLE");
    if (Date.parse(grant.grantExpiresAt) <= startTime) return deny("AUTHORIZATION_GRANT_EXPIRED");
    let latest;
    try { latest = await registrationRuntime.get(request.adapterId); }
    catch { return deny("ADAPTER_REGISTRATION_REVALIDATION_FAILED"); }
    if (!latest?.ok || !latest.record ||
        latest.record.revision !== grant.registrationRevision ||
        latest.record.contractDigest !== grant.contractDigest ||
        latest.record.contract.implementation.artifactDigest !== grant.artifactDigest ||
        latest.record.integration.state !== "VERIFIED_READ_ONLY") {
      return deny("REGISTRATION_CHANGED_BEFORE_EXECUTION");
    }
    if (!(await fence(request, grant, latest.record, "BEFORE_START"))) {
      return deny("EXECUTION_FENCE_REJECTED");
    }

    const startEvent = makeEvent({
      eventType: "adapter.execution.started",
      invocationId,
      request,
      grant,
      record,
      occurredAt,
      isolationEvidenceRef: isolation.evidenceRef,
    });
    let started;
    try {
      started = await executionStore.startWithAudit({ invocation, event: startEvent });
    } catch {
      started = null;
    }
    if (started !== "STARTED") return deny("EXECUTION_START_NOT_COMMITTED");

    let workerResult;
    try {
      workerResult = await workerSupervisor.runInRestrictedProcess(Object.freeze({
        supervisorRef: supervisor.supervisorRef,
        invocation,
        timeoutMs,
        memoryLimitMb,
        maxOutputBytes,
      }));
    } catch {
      workerResult = null;
    }

    const normalizedResult = normalizeWorkerResult(workerResult);
    if (!normalizedResult) {
      const unknown = Object.freeze({
        status: "UNKNOWN",
        workerRef: "worker.unknown",
        resultRef: null,
        resultDigest: null,
        finishedAt: new Date(nowValue(now) ?? timestamp).toISOString(),
        reasonCode: "WORKER_OUTCOME_UNRECORDED",
      });
      const finishEvent = makeEvent({
        eventType: "adapter.execution.unknown",
        invocationId,
        request,
        grant,
        record,
        occurredAt: unknown.finishedAt,
        result: unknown,
        reasonCode: unknown.reasonCode,
        isolationEvidenceRef: isolation.evidenceRef,
      });
      let committed;
      try {
        committed = await executionStore.finishWithAudit({
          invocationId, result: unknown, event: finishEvent,
        });
      } catch { committed = null; }
      return deny(committed === "FINISHED"
        ? "EXECUTION_OUTCOME_UNKNOWN"
        : "EXECUTION_OUTCOME_UNRECORDED");
    }

    const afterFence = await fence(request, grant, record, "AFTER_EXECUTION");
    const eventType = !afterFence
      ? "adapter.execution.quarantined"
      : normalizedResult.status === "COMPLETED"
        ? "adapter.execution.completed"
        : "adapter.execution.failed";
    const finishEvent = makeEvent({
      eventType,
      invocationId,
      request,
      grant,
      record,
      occurredAt: normalizedResult.finishedAt,
      result: normalizedResult,
      reasonCode: afterFence ? normalizedResult.reasonCode : "POST_EXECUTION_FENCE_REJECTED",
      isolationEvidenceRef: isolation.evidenceRef,
    });
    let committed;
    try {
      committed = await executionStore.finishWithAudit({
        invocationId,
        result: normalizedResult,
        event: finishEvent,
      });
    } catch { committed = null; }
    if (committed !== "FINISHED") return deny("EXECUTION_OUTCOME_UNRECORDED");
    if (!afterFence) return deny("EXECUTION_RESULT_QUARANTINED");
    if (normalizedResult.status !== "COMPLETED") {
      return deny(normalizedResult.reasonCode ?? "ADAPTER_EXECUTION_FAILED");
    }

    return Object.freeze({
      ok: true,
      allowed: true,
      code: "READ_EXECUTION_COMPLETED",
      invocationId,
      adapterId: record.adapterId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      resultRef: normalizedResult.resultRef,
      resultDigest: normalizedResult.resultDigest,
      finishedAt: normalizedResult.finishedAt,
    });
  }

  return Object.freeze({ execute });
}
