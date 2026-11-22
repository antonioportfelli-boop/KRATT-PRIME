import test from "node:test";
import assert from "node:assert/strict";
import { createKrattSemanticPolicyAuthorizer } from "../src/semantic-policy-authorizer.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";

const now = Date.parse("2026-11-22T10:00:00.000Z");
const req = {
  action: "semantic.memory.append", requestId: "request-policy-01", principalId: "agent-policy-01",
  resource: "semantic-record:record-policy-01", recordId: "record-policy-01",
  recordDigest: "sha256:" + "a".repeat(64), evidenceIds: ["evidence-policy-01"], approval: null
};
const evidence = [{
  schema_version: KRATT_SCHEMA_VERSION, evidence_id: "evidence-policy-01", subject: "record-policy-01",
  claim_type: "ARTIFACT_CREATED", source: { source_type: "github", source_id: "source-policy-01", revision: null },
  observed_at: "2026-11-22T09:59:00.000Z", verification_method: "trusted-digest-verifier",
  result: "VERIFIED", artifact_digest: "sha256:" + "b".repeat(64), metadata: {}
}];
const context = {
  schema_version: KRATT_SCHEMA_VERSION,
  authorities: ["semantic-memory-writer"],
  allowed_targets: [{ resource_type: "semantic_record", resource_id: "record-policy-01" }],
  policies: [{
    action: "semantic.memory.append", required_authority: "semantic-memory-writer",
    target_types: ["semantic_record"], side_effect_class: "LOCAL_WRITE",
    required_claims: ["ARTIFACT_CREATED"]
  }],
  evaluated_at: "2026-11-22T10:00:00.000Z"
};
function create() {
  return createKrattSemanticPolicyAuthorizer({
    loadTrustedContext: async () => context,
    loadEvidence: async () => evidence,
    verifyEvidence: () => true,
    clock: () => now
  });
}
test("uses existing evaluatePolicy and returns an exact request-bound ALLOW", async () => {
  const decision = await create()(req);
  assert.equal(decision.decision, "ALLOW");
  assert.equal(decision.request_id, req.requestId);
  assert.equal(decision.principal_id, req.principalId);
  assert.equal(decision.record_digest, req.recordDigest);
  assert.deepEqual(decision.evidence, evidence);
});
test("policy scope mismatch denies semantic append", async () => {
  const authorize = createKrattSemanticPolicyAuthorizer({
    loadTrustedContext: async () => ({ ...context, allowed_targets: [] }),
    loadEvidence: async () => evidence,
    verifyEvidence: () => true,
    clock: () => now
  });
  const decision = await authorize(req);
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.reason, "TARGET_OUT_OF_SCOPE");
});
test("required approval is surfaced as pending rather than granted", async () => {
  const authorize = createKrattSemanticPolicyAuthorizer({
    loadTrustedContext: async () => ({
      ...context,
      policies: [{ ...context.policies[0], approval_required: true, approval_authority: "semantic-memory-approver" }]
    }),
    loadEvidence: async () => evidence,
    verifyEvidence: () => true,
    clock: () => now
  });
  const decision = await authorize(req);
  assert.equal(decision.decision, "REQUIRE_APPROVAL");
});
test("rejects a resource label that does not bind to the record id", async () => {
  await assert.rejects(
    create()({ ...req, resource: "semantic-record:other-record" }),
    { name: "TypeError", message: "SEMANTIC_POLICY_REQUEST_INVALID" }
  );
});
