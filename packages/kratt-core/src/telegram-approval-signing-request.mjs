import { createHash, randomUUID } from "node:crypto";
import { canonicalTelegramApprovalPayload } from "./telegram-approval-verifier.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const AUTHORITY = "kratt.claim.review";

function digest(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Prepare a canonical payload for an external Ed25519 signer.
 * This module never receives or stores private key material and never signs.
 */
export function createTelegramApprovalSigningRequest({
  request,
  intent,
  keyId,
  approvedBy,
  issuedAt,
  authority = AUTHORITY,
} = {}) {
  if (!request || !intent || intent.status !== "PENDING_SIGNATURE" ||
      intent.requestId !== request.requestId ||
      intent.actorTelegramUserId !== request.actorTelegramUserId ||
      intent.chatId !== request.chatId ||
      intent.targetDigest !== request.targetDigest ||
      intent.evidenceSnapshotDigest !== request.evidenceSnapshotDigest ||
      intent.rootDigest !== request.rootDigest ||
      intent.policyVersion !== request.policyVersion ||
      !["APPROVE","REJECT","CONTEST","ABSTAIN"].includes(intent.decision) ||
      typeof intent.reason !== "string" || intent.reason.length > 2000 ||
      typeof keyId !== "string" || !ID.test(keyId) ||
      typeof approvedBy !== "string" || approvedBy !== request.actorTelegramUserId ||
      typeof authority !== "string" || !ID.test(authority) ||
      authority !== AUTHORITY ||
      typeof issuedAt !== "string" || !Number.isFinite(Date.parse(issuedAt)) ||
      !Number.isFinite(Date.parse(request.expiresAt)) ||
      Date.parse(request.expiresAt) <= Date.parse(issuedAt)) {
    throw new TypeError("TELEGRAM_APPROVAL_SIGNING_REQUEST_INVALID");
  }

  const proof = Object.freeze({
    schema_version: "kratt-telegram-approval/v1",
    approval_id: randomUUID(),
    request_id: request.requestId,
    nonce: request.nonce,
    actor_telegram_user_id: request.actorTelegramUserId,
    chat_id: request.chatId,
    claim_id: request.claimId,
    target_digest: request.targetDigest,
    evidence_snapshot_digest: request.evidenceSnapshotDigest,
    root_digest: request.rootDigest,
    policy_version: request.policyVersion,
    decision: intent.decision,
    reason: intent.reason ?? "",
    issued_at: issuedAt,
    expires_at: request.expiresAt,
    approved_by: approvedBy,
    authority,
    key_id: keyId,
    signature: "",
  });
  const payload = canonicalTelegramApprovalPayload(proof);
  return Object.freeze({
    schemaVersion: "kratt-telegram-signing-request/v1",
    proof,
    payload,
    payloadDigest: digest(payload),
    algorithm: "Ed25519",
    encoding: "base64url",
    privateKeyHandling: "EXTERNAL_SIGNER_ONLY",
  });
}
