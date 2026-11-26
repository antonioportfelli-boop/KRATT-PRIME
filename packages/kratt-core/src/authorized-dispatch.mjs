import { createHash } from "node:crypto";
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
} = {}) {
  if (!authorizationRuntime || typeof authorizationRuntime.evaluate !== "function")
    throw new TypeError("TRUSTED_AUTHORIZATION_RUNTIME_REQUIRED");
  if (typeof authenticatePrincipal !== "function")
    throw new TypeError("PRINCIPAL_AUTHENTICATOR_REQUIRED");
  if (typeof loadTrustedContext !== "function" || typeof loadEvidence !== "function")
    throw new TypeError("TRUSTED_CONTEXT_AND_EVIDENCE_LOADERS_REQUIRED");
  if (!commandStore || typeof commandStore.appendDecision !== "function" ||
      typeof commandStore.commitAuthorizedIntent !== "function" ||
      typeof commandStore.beginAuthorizedDelivery !== "function" ||
      typeof commandStore.appendOutcome !== "function")
    throw new TypeError("DURABLE_COMMAND_STORE_REQUIRED");
  if (!plainObject(providerAdapters)) throw new TypeError("PROVIDER_ADAPTER_REGISTRY_REQUIRED");
  if (typeof now !== "function" || auditTime(now) === null)
    throw new TypeError("TRUSTED_AUDIT_CLOCK_REQUIRED");

  async function appendDenial(task, actorId, decision, reason) {
    const createdAt = auditTime(now);
    if (!createdAt) return { ok: false, reason: "TRUSTED_CLOCK_UNAVAILABLE" };
    const eventId = `decision:${digestId(`${task?.task_id ?? "invalid"}:${createdAt}:${reason}`)}`;
    const record = immutable({
      schema_version: AUDIT_SCHEMA,
      event_id: eventId,
      event_type: "authorization.denied",
      created_at: createdAt,
      actor_id: actorId ?? "unknown",
      task_id: typeof task?.task_id === "string" ? task.task_id : "invalid",
      decision,
      reason,
    });
    try {
      if (!succeeded(await commandStore.appendDecision(record)))
        return { ok: false, reason: "AUDIT_APPEND_FAILED" };
      return { ok: true };
    } catch {
      return { ok: false, reason: "AUDIT_APPEND_FAILED" };
    }
  }

  async function execute({ principal, task: taskInput, approval } = {}) {
    let identity;
    try { identity = await authenticatePrincipal(principal); }
    catch { return { status: "DENIED", reason: "PRINCIPAL_AUTHENTICATION_FAILED" }; }

    if (!plainObject(identity) || identity.active !== true ||
        typeof identity.id !== "string" || !ID.test(identity.id)) {
      return { status: "DENIED", reason: "PRINCIPAL_AUTHENTICATION_FAILED" };
    }

    const validated = validateTaskEnvelope(taskInput);
    if (!validated.ok) {
      const audit = await appendDenial(taskInput, identity.id, "DENY", "INVALID_TASK_ENVELOPE");
      return { status: "DENIED", reason: "INVALID_TASK_ENVELOPE", audit_recorded: audit.ok };
    }
    const task = validated.value;
    if (task.actor !== identity.id) {
      const audit = await appendDenial(task, identity.id, "DENY", "TASK_ACTOR_MISMATCH");
      return { status: "DENIED", reason: "TASK_ACTOR_MISMATCH", audit_recorded: audit.ok };
    }

    let trustedContext, evidence;
    try {
      [trustedContext, evidence] = await Promise.all([
        loadTrustedContext({ task, principal: identity }),
        loadEvidence({ task, principal: identity }),
      ]);
    } catch {
      const audit = await appendDenial(task, identity.id, "BLOCKED", "TRUSTED_INPUT_UNAVAILABLE");
      return { status: "BLOCKED", reason: "TRUSTED_INPUT_UNAVAILABLE", audit_recorded: audit.ok };
    }

    let decision;
    try {
      decision = authorizationRuntime.evaluate(task, evidence, trustedContext, { approval });
    } catch {
      const audit = await appendDenial(task, identity.id, "BLOCKED", "POLICY_EVALUATION_FAILED");
      return { status: "BLOCKED", reason: "POLICY_EVALUATION_FAILED", audit_recorded: audit.ok };
    }
    if (!isPolicyDecision(decision) || decision.decision !== "ALLOW") {
      const reason = isPolicyDecision(decision)
        ? (decision.reasons?.[0] ?? decision.decision)
        : "INVALID_POLICY_DECISION";
      const audit = await appendDenial(task, identity.id,
        isPolicyDecision(decision) ? decision.decision : "BLOCKED", reason);
      return {
        status: "DENIED",
        reason,
        decision: isPolicyDecision(decision) ? decision.decision : "BLOCKED",
        audit_recorded: audit.ok,
      };
    }

    const provider = task.constraints.provider;
    if (typeof provider !== "string" || !ID.test(provider)) {
      const audit = await appendDenial(task, identity.id, "DENY", "PROVIDER_NOT_BOUND");
      return { status: "DENIED", reason: "PROVIDER_NOT_BOUND", audit_recorded: audit.ok };
    }
    const adapter = Object.hasOwn(providerAdapters, provider) ? providerAdapters[provider] : null;
    if (!adapter || typeof adapter.dispatch !== "function") {
      const audit = await appendDenial(task, identity.id, "BLOCKED", "PROVIDER_ADAPTER_UNAVAILABLE");
      return { status: "BLOCKED", reason: "PROVIDER_ADAPTER_UNAVAILABLE", audit_recorded: audit.ok };
    }

    const canonicalDigest = canonicalTaskDigest(task);
    if (typeof canonicalDigest !== "string") {
      const audit = await appendDenial(task, identity.id, "BLOCKED", "TASK_DIGEST_UNAVAILABLE");
      return { status: "BLOCKED", reason: "TASK_DIGEST_UNAVAILABLE", audit_recorded: audit.ok };
    }
    const taskDigest = digestId(canonicalDigest);
    const idempotencyKey = `kratt:${task.task_id}:${taskDigest}`;
    const createdAt = auditTime(now);
    if (!createdAt) return { status: "BLOCKED", reason: "TRUSTED_CLOCK_UNAVAILABLE" };
    const intent = immutable({
      schema_version: AUDIT_SCHEMA,
      event_id: `intent:${digestId(idempotencyKey)}`,
      event_type: "dispatch.intent_committed",
      created_at: createdAt,
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
        record: intent,
      }));
    } catch { committed = false; }
    if (!committed) {
      return { status: "BLOCKED", reason: "INTENT_NOT_COMMITTED_OR_DUPLICATE", idempotency_key: idempotencyKey };
    }

    // The intent reservation alone is not permission to perform an external effect.
    // This second durable transaction orders cancellation against provider execution.
    let deliveryStart;
    try {
      deliveryStart = await commandStore.beginAuthorizedDelivery({
        idempotencyKey, taskId: task.task_id, actorId: identity.id, at: createdAt
      });
    } catch { deliveryStart = null; }
    if (!plainObject(deliveryStart) || deliveryStart.ok !== true ||
        typeof deliveryStart.deliveryToken !== "string" || !/^[a-f0-9]{64}$/.test(deliveryStart.deliveryToken)) {
      return { status: "BLOCKED", reason: "DELIVERY_START_NOT_COMMITTED_OR_CANCELLED", idempotency_key: idempotencyKey };
    }
    const deliveryToken = deliveryStart.deliveryToken;

    let adapterResult;
    try {
      adapterResult = safeAdapterResult(await adapter.dispatch({
        task,
        principal: identity,
        idempotencyKey,
      }));
    } catch {
      adapterResult = null;
    }

    const finishedAt = auditTime(now);
    if (!finishedAt) {
      return {
        status: "OUTCOME_UNRECORDED",
        reason: "TRUSTED_CLOCK_UNAVAILABLE",
        dispatched: adapterResult !== null,
        idempotency_key: idempotencyKey,
      };
    }

    const outcome = immutable({
      schema_version: AUDIT_SCHEMA,
      event_id: `outcome:${digestId(idempotencyKey)}`,
      event_type: adapterResult ? "dispatch.completed" : "dispatch.failed",
      created_at: finishedAt,
      actor_id: identity.id,
      task_id: task.task_id,
      provider,
      operation: task.action,
      idempotency_key: idempotencyKey,
      result: adapterResult ?? { status: "failed", reason: "PROVIDER_DISPATCH_FAILED_OR_INVALID_RESULT" },
    });
    try {
      if (!succeeded(await commandStore.appendOutcome({ idempotencyKey, deliveryToken, record: outcome }))) {
        return { status: "OUTCOME_UNRECORDED", reason: "OUTCOME_AUDIT_APPEND_FAILED", dispatched: adapterResult !== null, idempotency_key: idempotencyKey };
      }
    } catch {
      return { status: "OUTCOME_UNRECORDED", reason: "OUTCOME_AUDIT_APPEND_FAILED", dispatched: adapterResult !== null, idempotency_key: idempotencyKey };
    }

    if (!adapterResult) return { status: "FAILED", reason: "PROVIDER_DISPATCH_FAILED_OR_INVALID_RESULT", idempotency_key: idempotencyKey };
    return { status: "COMPLETED", idempotency_key: idempotencyKey, result: adapterResult };
  }

  return Object.freeze({ execute });
}
