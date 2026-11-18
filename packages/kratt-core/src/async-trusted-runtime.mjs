import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  canonicalTaskDigest,
  createRequestBoundApprovalSignatureVerifier,
  evaluatePolicy,
  isPolicyDecision,
} from "./policy.mjs";
import { validateTaskEnvelope } from "./contracts.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain = value => !!value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash("sha256").update(value, "utf8").digest("hex");

function createTrustedKeyring(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128)
    throw new TypeError("TRUSTED_APPROVAL_KEYRING_REQUIRED");
  const keys = new Map();
  for (const entry of entries) {
    if (!plain(entry) || !ID.test(entry.key_id ?? "") || !ID.test(entry.approver_id ?? "") ||
        typeof entry.public_key_pem !== "string" || entry.public_key_pem.length < 1 ||
        entry.public_key_pem.length > 8192 || !Array.isArray(entry.authorities) ||
        entry.authorities.length < 1 || entry.authorities.length > 32 ||
        entry.authorities.some(value => typeof value !== "string" || !ID.test(value)) ||
        keys.has(entry.key_id)) throw new TypeError("TRUSTED_APPROVAL_KEY_CONFIG_INVALID");
    let publicKey;
    try { publicKey = createPublicKey(entry.public_key_pem); }
    catch { throw new TypeError("TRUSTED_APPROVAL_PUBLIC_KEY_INVALID"); }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("TRUSTED_APPROVAL_KEY_TYPE_UNSUPPORTED");
    keys.set(entry.key_id, Object.freeze({
      publicKey,
      approverId: entry.approver_id,
      authorities: new Set(entry.authorities),
    }));
  }
  return keys;
}

/**
 * Async trusted entrypoint for Wave 5.
 *
 * Signature verification is pure and happens before the database transaction.
 * The verified nonce claims are then consumed atomically with cancellation
 * serialization, idempotency, intent, outbox and audit append by the PG store.
 * This is the composition root that bridges Wave 3 policy and Wave 4 storage.
 */
export function createAsyncTrustedAuthorizationRuntime({
  authenticatePrincipal,
  loadTrustedContext,
  loadEvidence,
  verifyEvidence,
  trustedApprovalKeys,
  commandStore,
  providerAdapters,
  now = () => Date.now(),
} = {}) {
  if (typeof authenticatePrincipal !== "function") throw new TypeError("PRINCIPAL_AUTHENTICATOR_REQUIRED");
  if (typeof loadTrustedContext !== "function" || typeof loadEvidence !== "function")
    throw new TypeError("TRUSTED_CONTEXT_AND_EVIDENCE_LOADERS_REQUIRED");
  if (typeof verifyEvidence !== "function") throw new TypeError("TRUSTED_EVIDENCE_VERIFIER_REQUIRED");
  if (!commandStore || typeof commandStore.reserveAuthorizedIntent !== "function" ||
      typeof commandStore.appendDecision !== "function") throw new TypeError("POSTGRES_OUTBOX_STORE_REQUIRED");
  if (!plain(providerAdapters)) throw new TypeError("EXPLICIT_PROVIDER_ADAPTER_REGISTRY_REQUIRED");
  if (typeof now !== "function") throw new TypeError("TRUSTED_CLOCK_REQUIRED");

  const keyring = createTrustedKeyring(trustedApprovalKeys);
  const readTime = () => {
    try {
      const value = now();
      const milliseconds = value instanceof Date ? value.getTime() : value;
      return typeof milliseconds === "number" && Number.isFinite(milliseconds) ? milliseconds : Number.NaN;
    } catch { return Number.NaN; }
  };
  if (!Number.isFinite(readTime())) throw new TypeError("TRUSTED_CLOCK_UNAVAILABLE");

  const verifyTrustedSignature = (payload, signature, artifact) => {
    const key = keyring.get(artifact?.key_id);
    if (!key || artifact.approved_by !== key.approverId || !key.authorities.has(artifact.authority) ||
        typeof signature !== "string") return false;
    try {
      const bytes = Buffer.from(signature, "base64url");
      if (bytes.length !== 64 || bytes.toString("base64url") !== signature) return false;
      return verifySignature(null, Buffer.from(payload, "utf8"), key.publicKey, bytes) === true;
    } catch { return false; }
  };

  const verifyApprovalSignature = createRequestBoundApprovalSignatureVerifier({
    verifySignature: verifyTrustedSignature,
    now: readTime,
  });

  async function appendDenial(task, actorId, reason, decision = "DENY") {
    if (!Number.isFinite(readTime())) return false;
    const at = new Date(readTime()).toISOString();
    const taskId = typeof task?.task_id === "string" && ID.test(task.task_id) ? task.task_id : "invalid";
    const actor = typeof actorId === "string" && ID.test(actorId) ? actorId : "unknown";
    const record = Object.freeze({
      schema_version: "kratt-audit/v1",
      event_id: "decision:" + digest(taskId + ":" + actor + ":" + at + ":" + reason),
      event_type: "authorization.denied",
      created_at: at,
      actor_id: actor,
      task_id: taskId,
      decision,
      reason,
    });
    try { return await commandStore.appendDecision(record) === true; }
    catch { return false; }
  }

  async function execute({ principal, task: taskInput, approval } = {}) {
    let identity;
    try { identity = await authenticatePrincipal(principal); }
    catch { return { status: "DENIED", reason: "PRINCIPAL_AUTHENTICATION_FAILED" }; }
    if (!plain(identity) || identity.active !== true || !ID.test(identity.id ?? "")) {
      return { status: "DENIED", reason: "PRINCIPAL_AUTHENTICATION_FAILED" };
    }

    const validated = validateTaskEnvelope(taskInput);
    if (!validated.ok) {
      const recorded = await appendDenial(taskInput, identity.id, "INVALID_TASK_ENVELOPE");
      return { status: "DENIED", reason: "INVALID_TASK_ENVELOPE", audit_recorded: recorded };
    }
    const task = validated.value;
    if (task.actor !== identity.id) {
      const recorded = await appendDenial(task, identity.id, "TASK_ACTOR_MISMATCH");
      return { status: "DENIED", reason: "TASK_ACTOR_MISMATCH", audit_recorded: recorded };
    }

    let trustedContext, evidence;
    try {
      [trustedContext, evidence] = await Promise.all([
        loadTrustedContext({ task, principal: identity }),
        loadEvidence({ task, principal: identity }),
      ]);
    } catch {
      const recorded = await appendDenial(task, identity.id, "TRUSTED_INPUT_UNAVAILABLE", "BLOCKED");
      return { status: "BLOCKED", reason: "TRUSTED_INPUT_UNAVAILABLE", audit_recorded: recorded };
    }

    const current = readTime();
    if (!Number.isFinite(current)) {
      const recorded = await appendDenial(task, identity.id, "TRUSTED_CLOCK_UNAVAILABLE", "BLOCKED");
      return { status: "BLOCKED", reason: "TRUSTED_CLOCK_UNAVAILABLE", audit_recorded: recorded };
    }

    let verifiedApprovalClaims = null;
    const approvalVerifier = (artifact, binding) => {
      verifiedApprovalClaims = null;
      if (!verifyApprovalSignature(artifact, binding)) return false;
      const signatureBytes = Buffer.from(artifact.signature, "base64url");
      verifiedApprovalClaims = Object.freeze({
        key_id: artifact.key_id,
        nonce: artifact.nonce,
        approval_id: artifact.approval_id,
        expires_at: artifact.expires_at,
        request_digest: artifact.request_digest,
        signature_digest: createHash("sha256").update(signatureBytes).digest("hex"),
      });
      return true;
    };

    let decision;
    try {
      decision = evaluatePolicy(task, evidence, trustedContext, {
        now: current,
        verifyEvidence,
        approvalVerifier,
        approval,
      });
    } catch {
      const recorded = await appendDenial(task, identity.id, "POLICY_EVALUATION_FAILED", "BLOCKED");
      return { status: "BLOCKED", reason: "POLICY_EVALUATION_FAILED", audit_recorded: recorded };
    }
    if (!isPolicyDecision(decision) || decision.decision !== "ALLOW") {
      const reason = isPolicyDecision(decision)
        ? (decision.reasons?.[0] ?? decision.decision)
        : "INVALID_POLICY_DECISION";
      const recorded = await appendDenial(task, identity.id, reason,
        isPolicyDecision(decision) ? decision.decision : "BLOCKED");
      return {
        status: "DENIED",
        reason,
        decision: isPolicyDecision(decision) ? decision.decision : "BLOCKED",
        audit_recorded: recorded,
      };
    }

    const provider = task.constraints.provider;
    if (typeof provider !== "string" || !ID.test(provider)) {
      const recorded = await appendDenial(task, identity.id, "PROVIDER_NOT_BOUND");
      return { status: "DENIED", reason: "PROVIDER_NOT_BOUND", audit_recorded: recorded };
    }
    const adapter = Object.hasOwn(providerAdapters, provider) ? providerAdapters[provider] : null;
    if (!adapter || typeof adapter.dispatch !== "function") {
      const recorded = await appendDenial(task, identity.id, "PROVIDER_ADAPTER_UNAVAILABLE", "BLOCKED");
      return { status: "BLOCKED", reason: "PROVIDER_ADAPTER_UNAVAILABLE", audit_recorded: recorded };
    }

    const taskDigest = canonicalTaskDigest(task);
    if (typeof taskDigest !== "string") {
      const recorded = await appendDenial(task, identity.id, "TASK_DIGEST_UNAVAILABLE", "BLOCKED");
      return { status: "BLOCKED", reason: "TASK_DIGEST_UNAVAILABLE", audit_recorded: recorded };
    }
    if (verifiedApprovalClaims && verifiedApprovalClaims.request_digest !== taskDigest) {
      const recorded = await appendDenial(task, identity.id, "APPROVAL_DIGEST_MISMATCH");
      return { status: "DENIED", reason: "APPROVAL_DIGEST_MISMATCH", audit_recorded: recorded };
    }
    const idempotencyKey = "kratt:" + task.task_id + ":" + taskDigest.slice(7);
    let reservation;
    try {
      reservation = await commandStore.reserveAuthorizedIntent({
        task,
        principal: identity,
        approval: verifiedApprovalClaims,
        idempotencyKey,
        providerPayload: { task, principal: { id: identity.id } },
      });
    } catch {
      return { status: "BLOCKED", reason: "INTENT_RESERVATION_FAILED", idempotency_key: idempotencyKey };
    }
    if (!reservation || reservation.ok !== true) {
      const reason = reservation?.reason ?? "INTENT_RESERVATION_FAILED";
      const recorded = await appendDenial(task, identity.id, reason, "BLOCKED");
      return {
        status: "BLOCKED",
        reason,
        audit_recorded: recorded,
        idempotency_key: idempotencyKey,
      };
    }
    return Object.freeze({
      status: "QUEUED",
      task_id: task.task_id,
      provider,
      idempotency_key: idempotencyKey,
      intent_id: reservation.intent_id,
      outbox_id: reservation.outbox_id,
      audit_sequence: reservation.audit_sequence,
      decision_id: decision.decision_id,
      evidence_ids: decision.evidence_ids,
    });
  }

  return Object.freeze({ execute, keyCount: keyring.size });
}
