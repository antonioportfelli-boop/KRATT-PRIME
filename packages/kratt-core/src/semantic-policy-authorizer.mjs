import { evaluatePolicy } from "./policy.mjs";
import { KRATT_SCHEMA_VERSION } from "./contracts.mjs";

const ACTION = "semantic.memory.append";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

/**
 * Adapter from the semantic ingestion request to KRATT's existing policy evaluator.
 * Policy context, evidence and signature/nonce verification are trusted server-side
 * dependencies. The returned ALLOW is bound to the exact semantic record digest.
 */
export function createKrattSemanticPolicyAuthorizer({
  loadTrustedContext, loadEvidence, verifyEvidence, approvalVerifier, clock = () => Date.now()
} = {}) {
  if (typeof loadTrustedContext !== "function" || typeof loadEvidence !== "function"
      || typeof verifyEvidence !== "function" || typeof clock !== "function") {
    throw new TypeError("SEMANTIC_POLICY_DEPENDENCIES_REQUIRED");
  }

  return async function authorize(request) {
    if (!request || request.action !== ACTION || !ID.test(request.requestId ?? "")
        || !ID.test(request.principalId ?? "") || !ID.test(request.recordId ?? "")
        || !/^sha256:[a-f0-9]{64}$/.test(request.recordDigest ?? "")) {
      throw new TypeError("SEMANTIC_POLICY_REQUEST_INVALID");
    }
    const now = clock();
    if (!Number.isFinite(now)) throw new TypeError("SEMANTIC_POLICY_CLOCK_INVALID");
    const createdAt = new Date(now).toISOString();
    const task = {
      schema_version: KRATT_SCHEMA_VERSION,
      task_id: request.requestId,
      actor: request.principalId,
      action: ACTION,
      target: { resource_type: "semantic_record", resource_id: request.recordId },
      constraints: {
        provider: "kratt-semantic-runtime",
        semantic_record_digest: request.recordDigest
      },
      required_evidence: [{
        claim_type: "ARTIFACT_CREATED",
        subject: request.recordId,
        required: true,
        revision: null
      }],
      created_at: createdAt,
      requested_authority: [ACTION],
      status: "PENDING"
    };

    const [context, evidence] = await Promise.all([
      loadTrustedContext({ request, task }),
      loadEvidence({
        requestId: request.requestId,
        principalId: request.principalId,
        recordId: request.recordId,
        evidenceIds: request.evidenceIds
      })
    ]);
    if (!Array.isArray(evidence)) throw new TypeError("SEMANTIC_POLICY_EVIDENCE_INVALID");
    const decision = evaluatePolicy(task, evidence, context, {
      now,
      verifyEvidence,
      approval: request.approval,
      approvalVerifier
    });
    const reason = decision.reasons?.[0] ?? "SEMANTIC_POLICY_NOT_ALLOW";
    const decisionValue = decision.decision === "ALLOW" ? "ALLOW"
      : request.approval == null && ["REQUEST_BOUND_APPROVAL_REQUIRED", "APPROVAL_INVALID_OR_MISSING"].includes(reason)
        ? "REQUIRE_APPROVAL" : decision.decision;
    return Object.freeze({
      decision: decisionValue,
      decision_id: decision.decision_id,
      request_id: request.requestId,
      principal_id: request.principalId,
      action: ACTION,
      resource: request.resource,
      record_digest: request.recordDigest,
      reason,
      evidence: decisionValue === "ALLOW" ? evidence : undefined
    });
  };
}
