import { createTelegramApprovalSigningRequest } from "../../kratt-core/src/telegram-approval-signing-request.mjs";

/**
 * Bridge to an operator-controlled Ed25519 signer (hardware key, OS keystore,
 * or separately governed signing service). Private key material never enters
 * this module or KRATT's Telegram process.
 */
export function createTelegramExternalSignerAdapter({
  signer,
  keyId,
  approvedBy,
  verifyApproval,
} = {}) {
  if (!signer || typeof signer.signEd25519 !== "function") {
    throw new TypeError("TELEGRAM_EXTERNAL_SIGNER_REQUIRED");
  }
  if (typeof keyId !== "string" || keyId.length < 1 || keyId.length > 192 ||
      typeof approvedBy !== "string" || approvedBy.length < 1 || approvedBy.length > 192 ||
      typeof verifyApproval !== "function") {
    throw new TypeError("TELEGRAM_EXTERNAL_SIGNER_CONFIG_INVALID");
  }

  return Object.freeze({
    async signIntent({ request, intent, issuedAt } = {}) {
      if (!request || !intent || request.actorTelegramUserId !== approvedBy ||
          intent.actorTelegramUserId !== approvedBy || intent.status !== "PENDING_SIGNATURE") {
        return Object.freeze({ status: "DENY", reason: "TELEGRAM_EXTERNAL_SIGNER_ACTOR_OR_STATE_MISMATCH" });
      }
      let signingRequest;
      try {
        signingRequest = createTelegramApprovalSigningRequest({
          request,
          intent,
          keyId,
          approvedBy,
          issuedAt,
        });
      } catch {
        return Object.freeze({ status: "DENY", reason: "TELEGRAM_APPROVAL_SIGNING_REQUEST_INVALID" });
      }

      let signature;
      try {
        signature = await signer.signEd25519(Object.freeze({
          algorithm: signingRequest.algorithm,
          payload: signingRequest.payload,
          payloadDigest: signingRequest.payloadDigest,
          keyId,
          approvedBy,
          encoding: signingRequest.encoding,
        }));
      } catch {
        return Object.freeze({ status: "ERROR", reason: "TELEGRAM_EXTERNAL_SIGNER_UNAVAILABLE" });
      }
      if (typeof signature !== "string" || signature.length < 80 || signature.length > 128) {
        return Object.freeze({ status: "DENY", reason: "TELEGRAM_EXTERNAL_SIGNATURE_INVALID" });
      }
      const proof = Object.freeze({ ...signingRequest.proof, signature });
      const binding = Object.freeze({
        requestId: request.requestId,
        nonce: request.nonce,
        actorTelegramUserId: request.actorTelegramUserId,
        chatId: request.chatId,
        claimId: request.claimId,
        targetDigest: request.targetDigest,
        evidenceSnapshotDigest: request.evidenceSnapshotDigest,
        rootDigest: request.rootDigest,
        policyVersion: request.policyVersion,
        decision: intent.decision,
        reason: intent.reason ?? "",
        expiresAt: request.expiresAt,
      });
      let verified = false;
      try { verified = await verifyApproval(proof, binding) === true; } catch { verified = false; }
      if (!verified) return Object.freeze({ status: "DENY", reason: "TELEGRAM_EXTERNAL_SIGNATURE_VERIFICATION_FAILED" });
      return Object.freeze({
        status: "OK",
        reason: "TELEGRAM_EXTERNAL_SIGNATURE_VERIFIED",
        proof,
        payloadDigest: signingRequest.payloadDigest,
      });
    },
  });
}
