import { createPublicKey, verify as verifySignature } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const AUTHORITY_DEFAULT = "kratt.claim.review";
const MAX_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const PROOF_KEYS = Object.freeze([
  "schema_version", "approval_id", "request_id", "nonce",
  "actor_telegram_user_id", "chat_id", "claim_id", "target_digest",
  "evidence_snapshot_digest", "root_digest", "policy_version",
  "decision", "reason", "issued_at", "expires_at", "approved_by",
  "authority", "key_id", "signature"
]);

function canonicalProof(proof) {
  const payload = {};
  for (const key of PROOF_KEYS) if (key !== "signature") payload[key] = proof[key];
  return JSON.stringify(payload);
}

function validProofShape(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(proof))) return false;
  const keys = Reflect.ownKeys(proof);
  if (keys.length !== PROOF_KEYS.length || keys.some(key => typeof key !== "string" || !PROOF_KEYS.includes(key))) return false;
  for (const key of PROOF_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(proof, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  const ids = ["approval_id","request_id","nonce","actor_telegram_user_id","chat_id","claim_id","approved_by","authority","key_id"];
  const timestamp = value => typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  return proof.schema_version === "kratt-telegram-approval/v1" &&
    ids.every(key => typeof proof[key] === "string" && ID.test(proof[key])) &&
    ["target_digest","evidence_snapshot_digest","root_digest"].every(key =>
      typeof proof[key] === "string" && /^sha256:[0-9a-f]{64}$/.test(proof[key])) &&
    typeof proof.policy_version === "string" && proof.policy_version.length > 0 && proof.policy_version.length <= 128 &&
    ["APPROVE","REJECT","CONTEST","ABSTAIN"].includes(proof.decision) &&
    typeof proof.reason === "string" && proof.reason.length <= 2000 &&
    timestamp(proof.issued_at) && timestamp(proof.expires_at) &&
    typeof proof.signature === "string" && proof.signature.length <= 256;
}

/**
 * Verify an architect-signed Telegram review decision. Nonce consumption is
 * deliberately deferred to the durable decision transaction so the signed
 * decision and one-time nonce are committed atomically by the SQLite store.
 */
export function createTrustedTelegramDecisionVerifier({
  trustedApprovalKeys,
  now = () => Date.now(),
  authority = AUTHORITY_DEFAULT,
} = {}) {
  if (!Array.isArray(trustedApprovalKeys) || trustedApprovalKeys.length < 1 || trustedApprovalKeys.length > 128) {
    throw new TypeError("TELEGRAM_TRUSTED_KEYRING_REQUIRED");
  }
  if (typeof now !== "function" || typeof authority !== "string" || !ID.test(authority)) {
    throw new TypeError("TELEGRAM_TRUSTED_VERIFIER_CONFIG_INVALID");
  }
  const initial = now();
  if (!Number.isFinite(initial)) throw new TypeError("TELEGRAM_TRUSTED_CLOCK_UNAVAILABLE");
  const keyring = new Map();
  for (const item of trustedApprovalKeys) {
    if (!item || typeof item.key_id !== "string" || !ID.test(item.key_id) ||
        typeof item.approver_id !== "string" || !ID.test(item.approver_id) ||
        typeof item.public_key_pem !== "string" || !item.public_key_pem ||
        !Array.isArray(item.authorities) || !item.authorities.includes(authority) ||
        keyring.has(item.key_id)) throw new TypeError("TELEGRAM_TRUSTED_KEY_CONFIG_INVALID");
    let publicKey;
    try { publicKey = createPublicKey(item.public_key_pem); } catch { throw new TypeError("TELEGRAM_TRUSTED_PUBLIC_KEY_INVALID"); }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("TELEGRAM_TRUSTED_KEY_TYPE_UNSUPPORTED");
    keyring.set(item.key_id, Object.freeze({
      publicKey, approverId: item.approver_id, authorities: new Set(item.authorities),
    }));
  }

  return function verifyTelegramDecision(proof, binding) {
    if (!validProofShape(proof) || !binding || typeof binding !== "object") return false;
    const key = keyring.get(proof.key_id);
    if (!key || !key.authorities.has(proof.authority) || proof.authority !== authority ||
        proof.approved_by !== key.approverId ||
        proof.actor_telegram_user_id !== binding.actorTelegramUserId ||
        proof.approved_by !== binding.actorTelegramUserId ||
        proof.request_id !== binding.requestId || proof.nonce !== binding.nonce ||
        proof.chat_id !== binding.chatId || proof.claim_id !== binding.claimId ||
        proof.target_digest !== binding.targetDigest ||
        proof.evidence_snapshot_digest !== binding.evidenceSnapshotDigest ||
        proof.root_digest !== binding.rootDigest || proof.policy_version !== binding.policyVersion ||
        proof.decision !== binding.decision || proof.reason !== binding.reason ||
        Date.parse(proof.expires_at) !== Date.parse(binding.expiresAt)) return false;

    let current;
    try { current = now(); } catch { return false; }
    const issued = Date.parse(proof.issued_at), expires = Date.parse(proof.expires_at);
    if (!Number.isFinite(current) || issued > current + CLOCK_SKEW_MS ||
        expires <= current || expires <= issued || expires - issued > MAX_AGE_MS ||
        current - issued > MAX_AGE_MS) return false;
    try {
      const signature = Buffer.from(proof.signature, "base64url");
      if (signature.length !== 64 || signature.toString("base64url") !== proof.signature) return false;
      return verifySignature(null, Buffer.from(canonicalProof(proof), "utf8"), key.publicKey, signature) === true;
    } catch { return false; }
  };
}
