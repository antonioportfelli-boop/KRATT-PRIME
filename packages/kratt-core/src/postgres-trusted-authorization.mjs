import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  canonicalApprovalPayload,
  canonicalTaskDigest,
  evaluatePolicy,
  isPolicyDecision
} from "./policy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HEX = /^[a-f0-9]{64}$/;
const APPROVAL_MAX_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const digest = value => createHash("sha256").update(value, "utf8").digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function trustedKeyring(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128) {
    throw new TypeError("TRUSTED_APPROVAL_KEYRING_REQUIRED");
  }
  const result = new Map();
  for (const entry of entries) {
    if (!plain(entry) || !ID.test(entry.key_id ?? "") || !ID.test(entry.approver_id ?? "") ||
        typeof entry.public_key_pem !== "string" || entry.public_key_pem.length < 1 ||
        entry.public_key_pem.length > 8192 || !Array.isArray(entry.authorities) ||
        entry.authorities.length < 1 || entry.authorities.length > 32 ||
        entry.authorities.some(value => typeof value !== "string" || !ID.test(value)) ||
        result.has(entry.key_id)) {
      throw new TypeError("TRUSTED_APPROVAL_KEY_CONFIG_INVALID");
    }
    let publicKey;
    try { publicKey = createPublicKey(entry.public_key_pem); }
    catch { throw new TypeError("TRUSTED_APPROVAL_PUBLIC_KEY_INVALID"); }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("TRUSTED_APPROVAL_KEY_TYPE_UNSUPPORTED");
    }
    result.set(entry.key_id, Object.freeze({
      publicKey,
      approverId: entry.approver_id,
      authorities: new Set(entry.authorities)
    }));
  }
  return result;
}

/**
 * PostgreSQL-backed async authorization adapter for governed construction.
 *
 * Policy evaluation and Ed25519 signature verification are pure. A verified
 * request-bound nonce is then inserted atomically into the shared database.
 * The unique key/approval constraints prevent another process or host from
 * consuming the same approval. Nonce consumption is deliberately fail-closed:
 * if later lease or execution persistence fails, the approval remains spent
 * and a fresh approval is required.
 */
export function createPostgresTrustedAuthorizationRuntime({
  pool,
  trustedApprovalKeys,
  verifyEvidence,
  now = () => Date.now()
} = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("POSTGRES_POOL_REQUIRED");
  if (typeof verifyEvidence !== "function") throw new TypeError("TRUSTED_EVIDENCE_VERIFIER_REQUIRED");
  if (typeof now !== "function") throw new TypeError("TRUSTED_CLOCK_REQUIRED");
  const keyring = trustedKeyring(trustedApprovalKeys);

  function readTime() {
    try {
      const value = now();
      const number = value instanceof Date ? value.getTime() : value;
      return typeof number === "number" && Number.isFinite(number) ? number : Number.NaN;
    } catch { return Number.NaN; }
  }

  if (!Number.isFinite(readTime())) throw new TypeError("TRUSTED_CLOCK_UNAVAILABLE");

  function verifyBoundSignature(artifact, binding) {
    if (!plain(binding)) return null;
    const payload = canonicalApprovalPayload(artifact);
    if (typeof payload !== "string") return null;
    const key = keyring.get(artifact.key_id);
    if (!key || artifact.approved_by !== key.approverId ||
        !key.authorities.has(artifact.authority)) return null;

    const issuedAt = Date.parse(artifact.issued_at);
    const expiresAt = Date.parse(artifact.expires_at);
    const current = readTime();
    if (!Number.isFinite(current) || issuedAt > current + CLOCK_SKEW_MS ||
        expiresAt <= current || expiresAt <= issuedAt ||
        expiresAt - issuedAt > APPROVAL_MAX_AGE_MS ||
        current - issuedAt > APPROVAL_MAX_AGE_MS) return null;

    if (artifact.task_id !== binding.task_id || artifact.actor !== binding.actor ||
        artifact.provider !== binding.provider || artifact.operation !== binding.operation ||
        artifact.target?.resource_type !== binding.target?.resource_type ||
        artifact.target?.resource_id !== binding.target?.resource_id ||
        artifact.authority !== binding.authority ||
        artifact.request_digest !== binding.request_digest ||
        artifact.decision !== "APPROVE") return null;

    let signatureBytes;
    try {
      signatureBytes = Buffer.from(artifact.signature, "base64url");
      if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== artifact.signature ||
          verifySignature(null, Buffer.from(payload, "utf8"), key.publicKey, signatureBytes) !== true) {
        return null;
      }
    } catch { return null; }

    return Object.freeze({
      key_id: artifact.key_id,
      nonce: artifact.nonce,
      approval_id: artifact.approval_id,
      request_digest: artifact.request_digest,
      signature_digest: digest(signatureBytes),
      expires_at: artifact.expires_at
    });
  }

  async function consumeVerifiedApproval(claim) {
    if (!claim || !ID.test(claim.key_id) || !ID.test(claim.nonce) ||
        !ID.test(claim.approval_id) || !HEX.test(claim.request_digest?.slice(7) ?? "") ||
        !HEX.test(claim.signature_digest ?? "")) return false;
    try {
      const result = await pool.query(
        "INSERT INTO kratt_governed_approval_nonces " +
        "(key_id, nonce, approval_id, request_digest, signature_digest, expires_at, consumed_at) " +
        "SELECT $1, $2, $3, $4, $5, $6::timestamptz, clock_timestamp() " +
        "WHERE $6::timestamptz > clock_timestamp() " +
        "ON CONFLICT DO NOTHING RETURNING key_id",
        [claim.key_id, claim.nonce, claim.approval_id, claim.request_digest,
          claim.signature_digest, claim.expires_at]
      );
      return result?.rowCount === 1;
    } catch { return false; }
  }

  async function evaluate(task, evidence, context, { approval } = {}) {
    const current = readTime();
    if (!Number.isFinite(current)) {
      return Object.freeze({
        schema_version: "kratt-prime/v0.1",
        decision_id: "decision:" + (task?.task_id ?? "invalid"),
        task_id: task?.task_id ?? "invalid",
        decision: "BLOCKED",
        reasons: Object.freeze(["TRUSTED_TIME_UNAVAILABLE"]),
        evidence_ids: Object.freeze([]),
        evaluated_at: null
      });
    }

    let verifiedClaims = null;
    const approvalVerifier = (artifact, binding) => {
      verifiedClaims = null;
      const verified = verifyBoundSignature(artifact, binding);
      if (!verified) return false;
      verifiedClaims = verified;
      return true;
    };

    let decision;
    try {
      decision = evaluatePolicy(task, evidence, context, {
        now: current,
        verifyEvidence,
        approvalVerifier,
        approval
      });
    } catch {
      return Object.freeze({
        schema_version: "kratt-prime/v0.1",
        decision_id: "decision:" + (task?.task_id ?? "invalid"),
        task_id: task?.task_id ?? "invalid",
        decision: "BLOCKED",
        reasons: Object.freeze(["POLICY_EVALUATION_FAILED"]),
        evidence_ids: Object.freeze([]),
        evaluated_at: null
      });
    }
    if (!isPolicyDecision(decision) || decision.decision !== "ALLOW" || !verifiedClaims) {
      return decision;
    }

    const expectedTaskDigest = canonicalTaskDigest(task);
    if (!expectedTaskDigest || verifiedClaims.request_digest !== expectedTaskDigest) {
      return Object.freeze({
        ...decision,
        decision: "DENY",
        reasons: Object.freeze(["APPROVAL_DIGEST_MISMATCH"])
      });
    }

    const consumed = await consumeVerifiedApproval(verifiedClaims);
    if (!consumed) {
      return Object.freeze({
        ...decision,
        decision: "DENY",
        reasons: Object.freeze(["APPROVAL_REPLAYED_OR_NONCE_STORE_UNAVAILABLE"])
      });
    }
    return decision;
  }

  async function open() {
    await pool.query(
      "SELECT key_id, nonce FROM kratt_governed_approval_nonces LIMIT 0"
    );
    return Object.freeze({ ok: true, keyCount: keyring.size });
  }

  return Object.freeze({
    evaluate,
    open,
    keyCount: keyring.size,
    nonceMode: "POSTGRES_SHARED_UNIQUE_INSERT"
  });
}
