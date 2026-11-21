import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTelegramReflectionProposalService } from "../src/telegram-reflection-proposal.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const verifiedAt = "2026-11-10T14:00:00.000Z";

function fixture({ decision = "APPROVE", state = "CONSUMED", stale = false, delta = { operations: [{ type: "ANNOTATE_CLAIM", value: "reviewed" }] } } = {}) {
  const request = {
    requestId: "request-01", claimId: "claim-01", targetDigest: digest("claim"),
    evidenceSnapshotDigest: digest("evidence"), rootDigest: digest("root"),
    policyVersion: "strict/v1",
  };
  const record = {
    schemaVersion: "kratt-telegram-validation-decision/v1", decisionId: "decision-01",
    requestId: request.requestId, claimId: request.claimId, decision,
    targetDigest: request.targetDigest, evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest, policyVersion: request.policyVersion, verifiedAt,
  };
  let deltaInput;
  const service = createTelegramReflectionProposalService({
    decisionStore: {
      getReviewRequest() { return { request, state }; },
      getDecision() { return record; },
    },
    projectionService: {
      async get() {
        return {
          readOnly: true, truthVerdict: "NOT_ASSERTED", claimId: request.claimId,
          claimDigest: request.targetDigest, evidenceSnapshotDigest: request.evidenceSnapshotDigest,
          rootDigest: stale ? digest("new-root") : request.rootDigest, rootVersion: 8,
        };
      },
    },
    async buildRootDelta(input) { deltaInput = input; return delta; },
  });
  return { service, request, record, getDeltaInput: () => deltaInput };
}

test("creates a proposal only from a consumed, verified APPROVE decision and current projection", async () => {
  const { service, request, getDeltaInput } = fixture();
  const result = await service.createProposal({ requestId: request.requestId });
  assert.equal(result.status, "OK");
  assert.equal(result.proposal.status, "PROPOSAL_ONLY");
  assert.equal(result.proposal.applyStatus, "NOT_APPLIED");
  assert.equal(result.proposal.expectedRootVersion, 8);
  assert.equal(result.proposal.expectedRootDigest, request.rootDigest);
  assert.match(result.proposal.rootDeltaDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(getDeltaInput().expectedRoot.rootDigest, request.rootDigest);
  assert.equal(Object.isFrozen(result.proposal.rootDelta.operations[0]), true);
});

test("rejects unconsumed decisions and non-APPROVE outcomes", async () => {
  const pending = fixture({ state: "PENDING" });
  assert.equal((await pending.service.createProposal({ requestId: "request-01" })).status, "BLOCKED");
  const rejected = fixture({ decision: "REJECT" });
  assert.equal((await rejected.service.createProposal({ requestId: "request-01" })).reason, "REFLECTION_PROPOSAL_DECISION_BINDING_INVALID");
});

test("blocks when the canonical root snapshot changed after the decision", async () => {
  const { service } = fixture({ stale: true });
  const result = await service.createProposal({ requestId: "request-01" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "REFLECTION_PROPOSAL_STALE_OR_UNVERIFIED_PROJECTION");
});

test("rejects non-canonical or oversized RootDelta values", async () => {
  const accessor = {};
  Object.defineProperty(accessor, "mutate", { enumerable: true, get() { return true; } });
  const invalid = fixture({ delta: accessor });
  assert.equal((await invalid.service.createProposal({ requestId: "request-01" })).reason, "REFLECTION_PROPOSAL_DELTA_NOT_CANONICAL");
  const oversized = fixture({ delta: { value: "x".repeat(132000) } });
  assert.equal((await oversized.service.createProposal({ requestId: "request-01" })).reason, "REFLECTION_PROPOSAL_DELTA_SHAPE_OR_SIZE_INVALID");
});

test("rejects unknown request IDs and missing adapter contracts", async () => {
  const { service } = fixture();
  assert.equal((await service.createProposal({ requestId: "" })).status, "DENY");
  assert.throws(() => createTelegramReflectionProposalService({}), /TELEGRAM_REFLECTION_PROPOSAL_ADAPTERS_REQUIRED/);
});
