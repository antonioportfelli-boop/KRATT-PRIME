import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { validateTaskEnvelope, KRATT_SCHEMA_VERSION } from "./contracts.mjs";
import { canonicalTaskDigest, isPolicyDecision } from "./policy.mjs";

const AUDIT_SCHEMA = "kratt-audit/v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function succeeded(result) {
  return result === true || (plainObject(result) && result.ok === true);
}

function immutable(value) {
  return Object.freeze(structuredClone(value));
}

function auditTime(now) {
  let value;
  try { value = now(); } catch { return null; }
  if (!Number.isFinite(value) || value < 0) return null;
  return new Date(value).toISOString();
}

function digestId(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeAdapterResult(value) {
  if (!plainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" ||
      !["status", "provider_reference", "result_digest"].includes(key))) return null;
  if (keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !Object.hasOwn(descriptor, "value");
  })) return null;
  if (!["accepted", "completed"].includes(value.status)) return null;
  if (value.provider_reference !== undefined &&
      (typeof value.provider_reference !== "string" || value.provider_reference.length > 256)) return null;
  if (value.result_digest !== undefined &&
      (typeof value.result_digest !== "string" || !DIGEST.test(value.result_digest))) return null;
  return Object.freeze({
    status: value.status,
    ...(value.provider_reference === undefined ? {} : { provider_reference: value.provider_reference }),
    ...(value.result_digest === undefined ? {} : { result_digest: value.result_digest }),
  });
}

/**
 * Asynchronous server composition root for authorized provider dispatch.
 *
 * Required commandStore contract:
 * - appendDecision(record): durably append a denial/blocked decision.
 * - commitAuthorizedIntent({ idempotencyKey, taskId, record }): atomically
 *   reject cancelled tasks, claim the idempotency key, and append the intent.
 * - appendOutcome({ idempotencyKey, record }): durably append the dispatch result.
 *
 * The authorizationRuntime remains responsible for cryptographic approval
 * verification and durable one-time nonce consumption. This layer never
 * dispatches before a durable intent commit succeeds.
 */
export function createAuthorizedDispatchRuntime({
  authorizationRuntime,
  authenticatePrincipal,
  loadTrustedContext,
  loadEvidence,
  commandStore,
  providerAdapters,
  now,
  telemetry,
} = {}) {
  if (!authorizationRuntime || typeof authorizationRuntime.evaluate !== "function")
    throw new TypeError("TRUSTED_AUTHORIZATION_RUNTIME_REQUIRED");
  if (typeof authenticatePrincipal !== "function")
    throw new TypeError("PRINCIPAL_AUTHENTICATOR_REQUIRED");
  if (typeof loadTrustedContext !== "function" || typeof loadEvidence !== "function")
    throw new TypeError("TRUSTED_CONTEXT_AND_EVIDENCE_LOADERS_REQUIRED");
  if (!commandStore || typeof commandStore.appendDecision !== "function" ||
      typeof commandStore.commitAuthorizedIntent !== "function" ||
      typeof commandStore.appendOutcome !== "function")
    throw new TypeError("DURABLE_COMMAND_STORE_REQUIRED");
  if (!plainObject(providerAdapters)) throw new TypeError("PROVIDER_ADAPTER_REGISTRY_REQUIRED");
  if (telemetry !== undefined && (!telemetry || typeof telemetry.recordSecurityEvent !== "function"))
    throw new TypeError("SECURITY_TELEMETRY_INVALID");
  if (typeof now !== "function" || auditTime(now) === null)
    throw new TypeError("TRUSTED_AUDIT_CLOCK_REQUIRED");

  function emitTelemetry(name, correlationId, outcome, reason, durationMs = null) {
    if (!telemetry) return;
    const safeReason = typeof reason === "string" && /^[A-Z0-9_:-]{1,96}$/.test(reason)
      ? reason : "UNSPECIFIED";
    try {
      telemetry.recordSecurityEvent({
        name,
        correlationId,
        component: "authorized-dispatch",
        outcome,
        reason: safeReason,
        ...(durationMs === null ? {} : { durationMs }),
      });
    } catch {
      // Telemetry is deliberately non-authoritative.
    }
  }

  async function appendDenial(task, actorId, decision, reason, correlationId) {
    const createdAt = auditTime(now);
    if (!createdAt) {
      emitTelemetry(
        decision === "DENY" ? "authorization.denied" : "authorization.blocked",
        correlationId,
        decision === "DENY" ? "denied" : "blocked",
        reason,
      );
      return { ok: false, reason: "TRUSTED_CLOCK_UNAVAILABLE" };
    }
    const eventId = "decision:" + digestId(
      String(task?.task_id ?? "invalid") + ":" + createdAt + ":" + reason + ":" + correlationId
    );
    const record = immutable({
      schema_version: AUDIT_SCHEMA,
      event_id: eventId,
      event_type: decision === "DENY" ? "authorization.denied" : "authorization.blocked",
      created_at: createdAt,
      correlation_id: correlationId,
      actor_id: actorId ?? "unknown",
      task_id: typeof task?.task_id === "string" ? task.task_id : "invalid",
      decision,
      reason,
    });
    let ok = false;
    try {
      ok = succeeded(await commandStore.appendDecision(record));
    } catch {
      ok = false;
    }
    emitTelemetry(
      decision === "DENY" ? "authorization.denied" : "authorization.blocked",
      correlationId,
      decision === "DENY" ? "denied" : "blocked",
      reason,
    );
    return { ok, ...(ok ? {} : { reason: "AUDIT_APPEND_FAILED" }) };
  }
  async function execute({
    principal,
    task: taskInput,
    approval,
    correlationId: suppliedCorrelationId,
  } = {}) {
    const correlationId = suppliedCorrelationId === undefined ? randomUUID() : suppliedCorrelationId;
    if (typeof correlationId !== "string" || !ID.test(correlationId)) {
      const safeCorrelationId = randomUUID();
      const audit = await appendDenial(
        taskInput, "unknown", "DENY", "INVALID_CORRELATION_ID", safeCorrelationId
      );
      return {
        status: "DENIED",
        reason: "INVALID_CORRELATION_ID",
        audit_recorded: audit.ok,
        correlation_id: safeCorrelationId,
      };
    }

    let identity;
    try {
      identity = await authenticatePrincipal(principal, { correlationId });
    } catch {
      const audit = await appendDenial(
        taskInput, "unknown", "DENY", "PRINCIPAL_AUTHENTICATION_FAILED", correlationId
      );
      return {
        status: "DENIED", reason: "PRINCIPAL_AUTHENTICATION_FAILED",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    if (!plainObject(identity) || identity.active !== true ||
        typeof identity.id !== "string" || !ID.test(identity.id)) {
      const audit = await appendDenial(
        taskInput, "unknown", "DENY", "PRINCIPAL_AUTHENTICATION_FAILED", correlationId
      );
      return {
        status: "DENIED", reason: "PRINCIPAL_AUTHENTICATION_FAILED",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    const validated = validateTaskEnvelope(taskInput);
    if (!validated.ok) {
      const audit = await appendDenial(
        taskInput, identity.id, "DENY", "INVALID_TASK_ENVELOPE", correlationId
      );
      return {
        status: "DENIED", reason: "INVALID_TASK_ENVELOPE",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }
    const task = validated.value;
    if (task.actor !== identity.id) {
      const audit = await appendDenial(
        task, identity.id, "DENY", "TASK_ACTOR_MISMATCH", correlationId
      );
      return {
        status: "DENIED", reason: "TASK_ACTOR_MISMATCH",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    let trustedContext, evidence;
    try {
      [trustedContext, evidence] = await Promise.all([
        loadTrustedContext({ task, principal: identity, correlationId }),
        loadEvidence({ task, principal: identity, correlationId }),
      ]);
    } catch {
      const audit = await appendDenial(
        task, identity.id, "BLOCKED", "TRUSTED_INPUT_UNAVAILABLE", correlationId
      );
      return {
        status: "BLOCKED", reason: "TRUSTED_INPUT_UNAVAILABLE",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    let decision;
    const authorizationStartedAt = performance.now();
    try {
      decision = authorizationRuntime.evaluate(task, evidence, trustedContext, {
        approval, correlationId,
      });
    } catch {
      const audit = await appendDenial(
        task, identity.id, "BLOCKED", "POLICY_EVALUATION_FAILED", correlationId
      );
      return {
        status: "BLOCKED", reason: "POLICY_EVALUATION_FAILED",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    if (!isPolicyDecision(decision) || decision.decision !== "ALLOW") {
      const decisionValue = isPolicyDecision(decision) ? decision.decision : "BLOCKED";
      const reason = isPolicyDecision(decision)
        ? (decision.reasons?.[0] ?? decisionValue)
        : "INVALID_POLICY_DECISION";
      const audit = await appendDenial(
        task, identity.id, decisionValue, reason, correlationId
      );
      return {
        status: decisionValue === "DENY" ? "DENIED" : "BLOCKED",
        reason,
        decision: decisionValue,
        audit_recorded: audit.ok,
        correlation_id: correlationId,
      };
    }

    emitTelemetry(
      "authorization.allowed",
      correlationId,
      "allowed",
      "ALL_CONDITIONS_SATISFIED",
      performance.now() - authorizationStartedAt,
    );

    const provider = task.constraints.provider;
    if (typeof provider !== "string" || !ID.test(provider)) {
      const audit = await appendDenial(
        task, identity.id, "BLOCKED", "PROVIDER_NOT_BOUND", correlationId
      );
      return {
        status: "BLOCKED", reason: "PROVIDER_NOT_BOUND",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }
    const adapter = Object.hasOwn(providerAdapters, provider) ? providerAdapters[provider] : null;
    if (!adapter || typeof adapter.dispatch !== "function") {
      const audit = await appendDenial(
        task, identity.id, "BLOCKED", "PROVIDER_ADAPTER_UNAVAILABLE", correlationId
      );
      return {
        status: "BLOCKED", reason: "PROVIDER_ADAPTER_UNAVAILABLE",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    const canonicalDigest = canonicalTaskDigest(task);
    if (typeof canonicalDigest !== "string") {
      const audit = await appendDenial(
        task, identity.id, "BLOCKED", "TASK_DIGEST_UNAVAILABLE", correlationId
      );
      return {
        status: "BLOCKED", reason: "TASK_DIGEST_UNAVAILABLE",
        audit_recorded: audit.ok, correlation_id: correlationId,
      };
    }

    const taskDigest = digestId(canonicalDigest);
    const idempotencyKey = "kratt:" + task.task_id + ":" + taskDigest;
    const createdAt = auditTime(now);
    if (!createdAt) {
      emitTelemetry("authorization.blocked", correlationId, "blocked", "TRUSTED_CLOCK_UNAVAILABLE");
      return {
        status: "BLOCKED", reason: "TRUSTED_CLOCK_UNAVAILABLE",
        correlation_id: correlationId,
      };
    }

    const intent = immutable({
      schema_version: AUDIT_SCHEMA,
      event_id: "intent:" + digestId(idempotencyKey),
      event_type: "dispatch.intent_committed",
      created_at: createdAt,
      correlation_id: correlationId,
      actor_id: identity.id,
      task_id: task.task_id,
      provider,
      operation: task.action,
      target: task.target,
      decision_id: decision.decision_id,
      idempotency_key: idempotencyKey,
    });

    let committed = false;
    try {
      committed = succeeded(await commandStore.commitAuthorizedIntent({
        idempotencyKey,
        taskId: task.task_id,
        correlationId,
        record: intent,
      }));
    } catch {
      committed = false;
    }
    if (!committed) {
      const audit = await appendDenial(
        task, identity.id, "BLOCKED", "INTENT_NOT_COMMITTED_OR_DUPLICATE", correlationId
      );
      return {
        status: "BLOCKED",
        reason: "INTENT_NOT_COMMITTED_OR_DUPLICATE",
        idempotency_key: idempotencyKey,
        audit_recorded: audit.ok,
        correlation_id: correlationId,
      };
    }
    emitTelemetry("dispatch.intent_committed", correlationId, "completed", "DURABLE_INTENT_COMMITTED");

    let adapterResult;
    try {
      adapterResult = safeAdapterResult(await adapter.dispatch({
        task,
        principal: identity,
        idempotencyKey,
        correlationId,
      }));
    } catch {
      adapterResult = null;
    }

    const finishedAt = auditTime(now);
    if (!finishedAt) {
      emitTelemetry("dispatch.failed", correlationId, "failed", "TRUSTED_CLOCK_UNAVAILABLE");
      return {
        status: "OUTCOME_UNRECORDED",
        reason: "TRUSTED_CLOCK_UNAVAILABLE",
        dispatched: adapterResult !== null,
        idempotency_key: idempotencyKey,
        correlation_id: correlationId,
      };
    }

    const outcome = immutable({
      schema_version: AUDIT_SCHEMA,
      event_id: "outcome:" + digestId(idempotencyKey),
      event_type: adapterResult ? "dispatch.completed" : "dispatch.failed",
      created_at: finishedAt,
      correlation_id: correlationId,
      actor_id: identity.id,
      task_id: task.task_id,
      provider,
      operation: task.action,
      idempotency_key: idempotencyKey,
      result: adapterResult ?? {
        status: "failed", reason: "PROVIDER_DISPATCH_FAILED_OR_INVALID_RESULT",
      },
    });
    try {
      if (!succeeded(await commandStore.appendOutcome({
        idempotencyKey, correlationId, record: outcome,
      }))) {
        emitTelemetry("dispatch.failed", correlationId, "failed", "OUTCOME_AUDIT_APPEND_FAILED");
        return {
          status: "OUTCOME_UNRECORDED",
          reason: "OUTCOME_AUDIT_APPEND_FAILED",
          dispatched: adapterResult !== null,
          idempotency_key: idempotencyKey,
          correlation_id: correlationId,
        };
      }
    } catch {
      emitTelemetry("dispatch.failed", correlationId, "failed", "OUTCOME_AUDIT_APPEND_FAILED");
      return {
        status: "OUTCOME_UNRECORDED",
        reason: "OUTCOME_AUDIT_APPEND_FAILED",
        dispatched: adapterResult !== null,
        idempotency_key: idempotencyKey,
        correlation_id: correlationId,
      };
    }

    if (!adapterResult) {
      emitTelemetry(
        "dispatch.failed", correlationId, "failed", "PROVIDER_DISPATCH_FAILED_OR_INVALID_RESULT"
      );
      return {
        status: "FAILED",
        reason: "PROVIDER_DISPATCH_FAILED_OR_INVALID_RESULT",
        idempotency_key: idempotencyKey,
        correlation_id: correlationId,
      };
    }

    emitTelemetry("dispatch.completed", correlationId, "completed", "PROVIDER_RESULT_DURABLY_RECORDED");
    return {
      status: "COMPLETED",
      idempotency_key: idempotencyKey,
      correlation_id: correlationId,
      result: adapterResult,
    };
  }

  return Object.freeze({ execute });
}
