import { createSqliteReflectionRootStore } from "./reflection-root-store.mjs";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function validTime(value) {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Re-verifies the durable Telegram approval at the exact point of Root CAS.
 * The caller must supply the trusted Ed25519 verifier backed by the configured
 * architect public-key ring. A proposal envelope by itself never authorizes a
 * root write.
 */
export function createTrustedTelegramReflectionProposalVerifier({
  decisionStore,
  verifyApprovalProof,
  now = () => Date.now(),
} = {}) {
  if (!decisionStore || typeof decisionStore.getReviewRequest !== "function" ||
      typeof decisionStore.getDecision !== "function" ||
      typeof verifyApprovalProof !== "function" || typeof now !== "function") {
    throw new TypeError("TELEGRAM_REFLECTION_TRUSTED_VERIFIER_ADAPTERS_REQUIRED");
  }

  return function verifyReflectionProposal(proposal, currentSnapshot) {
    try {
      if (!proposal || !currentSnapshot ||
          proposal.status !== "PROPOSAL_ONLY" || proposal.applyStatus !== "NOT_APPLIED" ||
          proposal.expectedRootVersion !== currentSnapshot.version ||
          proposal.expectedRootDigest !== currentSnapshot.digest) return false;

      const stored = decisionStore.getReviewRequest(proposal.requestId);
      const decision = decisionStore.getDecision(proposal.requestId);
      if (!stored || stored.state !== "CONSUMED" || !stored.request || !decision ||
          decision.schemaVersion !== "kratt-telegram-validation-decision/v1" ||
          decision.decision !== "APPROVE" || decision.decisionId !== proposal.decisionId ||
          decision.requestId !== proposal.requestId || !decision.approvalProof ||
          !validTime(decision.verifiedAt) ||
          proposal.createdFromVerifiedDecisionAt !== decision.verifiedAt) return false;

      const request = stored.request;
      if (request.requestId !== proposal.requestId ||
          request.claimId !== decision.claimId || request.claimId !== proposal.claimId ||
          request.targetDigest !== decision.targetDigest || request.targetDigest !== proposal.targetDigest ||
          request.evidenceSnapshotDigest !== decision.evidenceSnapshotDigest ||
          request.evidenceSnapshotDigest !== proposal.evidenceSnapshotDigest ||
          request.rootDigest !== decision.rootDigest || request.rootDigest !== proposal.expectedRootDigest ||
          request.policyVersion !== decision.policyVersion || request.policyVersion !== proposal.policyVersion ||
          decision.actorTelegramUserId !== request.actorTelegramUserId) return false;

      const current = now();
      const currentMs = typeof current === "string" ? Date.parse(current) : current;
      const verifiedMs = Date.parse(decision.verifiedAt);
      if (!Number.isFinite(currentMs) || verifiedMs > currentMs || currentMs - verifiedMs > 5 * 60_000) return false;

      const proof = decision.approvalProof;
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
        decision: decision.decision,
        reason: decision.reason,
        expiresAt: request.expiresAt,
      });
      return verifyApprovalProof(proof, binding) === true;
    } catch {
      return false;
    }
  };
}


/**
 * Compose the trusted Telegram decision re-verifier with the SQLite CAS root.
 * The caller supplies the already-configured SQLite database, durable
 * Telegram decision store, and trusted Ed25519 public-key verifier.
 */
export function createTelegramReflectionCasAdapter({
  database,
  initialSnapshot,
  decisionStore,
  verifyApprovalProof,
  now = () => Date.now(),
  validateDocument = () => true,
} = {}) {
  const verifyProposal = createTrustedTelegramReflectionProposalVerifier({
    decisionStore,
    verifyApprovalProof,
    now,
  });
  const rootStore = createSqliteReflectionRootStore(database, {
    initialSnapshot,
    verifyProposal,
    now: () => {
      const current = now();
      return new Date(typeof current === "string" ? Date.parse(current) : current).toISOString();
    },
    validateDocument,
  });
  return Object.freeze({ rootStore, verifyProposal });
}
