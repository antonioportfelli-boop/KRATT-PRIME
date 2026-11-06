import { createPublicKey, verify as verifySignature } from "node:crypto";
import { evaluatePolicy, canonicalApprovalPayload, createRequestBoundApprovalVerifier } from "./policy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

/**
 * Trusted server-side composition root for KRATT authorization.
 *
 * trustedApprovalKeys must come from deployment-controlled configuration, never
 * from task/request data. Each key is restricted to one approver identity and
 * an explicit set of approval authorities.
 *
 * nonceStore.consume must synchronously and atomically persist a one-time
 * (key_id, nonce) claim in durable shared storage. This module deliberately
 * does not provide an in-memory or file-backed production fallback.
 *
 * evaluate() is synchronous because the current policy engine is synchronous.
 * An asynchronous database nonce adapter requires a separate async policy
 * execution contract; do not wrap a Promise and pretend it was consumed.
 */
export function createTrustedAuthorizationRuntime({
  trustedApprovalKeys,
  nonceStore,
  verifyEvidence,
  now
} = {}) {
  if (!Array.isArray(trustedApprovalKeys) || trustedApprovalKeys.length === 0 ||
      trustedApprovalKeys.length > 128) {
    throw new TypeError("TRUSTED_APPROVAL_KEYRING_REQUIRED");
  }
  if (!nonceStore || typeof nonceStore.consume !== "function") {
    throw new TypeError("DURABLE_NONCE_STORE_REQUIRED");
  }
  if (typeof verifyEvidence !== "function") {
    throw new TypeError("TRUSTED_EVIDENCE_VERIFIER_REQUIRED");
  }
  if (typeof now !== "function") {
    throw new TypeError("TRUSTED_CLOCK_REQUIRED");
  }

  const consumeNonce = nonceStore.consume.bind(nonceStore);
  const readTrustedTime = () => {
    try { return now(); } catch { return Number.NaN; }
  };
  const keyring = new Map();
  for (const entry of trustedApprovalKeys) {
    if (!entry || typeof entry !== "object" ||
        typeof entry.key_id !== "string" || !ID.test(entry.key_id) ||
        typeof entry.approver_id !== "string" || !ID.test(entry.approver_id) ||
        typeof entry.public_key_pem !== "string" ||
        entry.public_key_pem.length === 0 || entry.public_key_pem.length > 8192 ||
        !Array.isArray(entry.authorities) || entry.authorities.length === 0 ||
        entry.authorities.length > 32 ||
        entry.authorities.some(authority => typeof authority !== "string" || !ID.test(authority)) ||
        keyring.has(entry.key_id)) {
      throw new TypeError("TRUSTED_APPROVAL_KEY_CONFIG_INVALID");
    }

    let publicKey;
    try {
      publicKey = createPublicKey(entry.public_key_pem);
    } catch {
      throw new TypeError("TRUSTED_APPROVAL_PUBLIC_KEY_INVALID");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("TRUSTED_APPROVAL_KEY_TYPE_UNSUPPORTED");
    }

    keyring.set(entry.key_id, Object.freeze({
      publicKey,
      approverId: entry.approver_id,
      authorities: new Set(entry.authorities)
    }));
  }

  const verifyTrustedSignature = (payload, signature, artifact) => {
    const trustedKey = keyring.get(artifact?.key_id);
    if (!trustedKey ||
        artifact.approved_by !== trustedKey.approverId ||
        !trustedKey.authorities.has(artifact.authority) ||
        typeof signature !== "string") return false;

    try {
      const bytes = Buffer.from(signature, "base64url");
      if (bytes.length !== 64 || bytes.toString("base64url") !== signature) return false;
      return verifySignature(null, Buffer.from(payload, "utf8"), trustedKey.publicKey, bytes) === true;
    } catch {
      return false;
    }
  };

  const approvalVerifier = createRequestBoundApprovalVerifier({
    now: readTrustedTime,
    verifySignature: verifyTrustedSignature,
    consumeNonce: (nonce, approvalId, expiresAt, keyId, nowMs) => {
      try {
        // A Promise is rejected: the synchronous evaluator cannot safely await it.
        const consumed = consumeNonce(keyId, nonce, approvalId, expiresAt, nowMs);
        if (consumed && typeof consumed.then === "function") return false;
        return consumed === true;
      } catch {
        return false;
      }
    }
  });

  function evaluate(task, evidence, trustedContext, { approval } = {}) {
    const current = readTrustedTime();
    if (!Number.isFinite(current)) {
      return evaluatePolicy(task, evidence, trustedContext, { now: Number.NaN });
    }
    return evaluatePolicy(task, evidence, trustedContext, {
      now: current,
      verifyEvidence,
      approvalVerifier,
      approval
    });
  }

  return Object.freeze({
    evaluate,
    get keyCount() { return keyring.size; }
  });
}

