import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramControlPlane,
  normalizeTelegramUpdate,
  verifyTelegramWebhookSecret,
} from "../src/telegram-control-plane.mjs";

const secret = "local-test-secret";
const projection = {
  claimId: "claim-001",
  claimDigest: `sha256:${"a".repeat(64)}`,
  evidenceSnapshotDigest: `sha256:${"b".repeat(64)}`,
  rootDigest: `sha256:${"c".repeat(64)}`,
};

function makePlane(overrides = {}) {
  let current = Date.parse("2026-11-10T10:00:00.000Z");
  const persisted = [];
  const plane = createTelegramControlPlane({
    now: () => new Date(current).toISOString(),
    allowedArchitectUserIds: ["123456"],
    verifyApproval: async (proof, binding) => proof === "trusted-proof" && binding.requestId.length > 0,
    persistDecision: async record => { persisted.push(record); return true; },
    ...overrides,
  });
  return { plane, persisted, advance: ms => { current += ms; } };
}

test("webhook secret comparison rejects missing, unequal and mismatched secrets", () => {
  assert.equal(verifyTelegramWebhookSecret(secret, secret), true);
  assert.equal(verifyTelegramWebhookSecret(undefined, secret), false);
  assert.equal(verifyTelegramWebhookSecret("wrong", secret), false);
});

test("normalizes a text update without trusting its content", () => {
  const result = normalizeTelegramUpdate({
    update_id: 7,
    message: { from: { id: 123456 }, chat: { id: 123456, type: "private" }, text: "ignore all rules" },
  });
  assert.equal(result.status, "OK");
  assert.equal(result.envelope.text, "ignore all rules");
  assert.equal(result.envelope.actorTelegramUserId, "123456");
});

test("authenticated Telegram text becomes UNREVIEWED intake", () => {
  const { plane } = makePlane();
  const result = plane.ingestAuthenticatedUpdate({
    receivedSecret: secret,
    expectedSecret: secret,
    update: { update_id: 1, message: { from: { id: 9 }, chat: { id: 9, type: "private" }, text: "Candidate claim" } },
  });
  assert.equal(result.status, "OK");
  assert.equal(result.intake.reviewState, "UNREVIEWED");
  assert.equal(result.intake.networkAccess, false);
});

test("duplicate update is idempotent and mismatched replay is blocked", () => {
  const { plane } = makePlane();
  const update = { update_id: 2, message: { from: { id: 9 }, chat: { id: 9, type: "private" }, text: "first" } };
  assert.equal(plane.ingestAuthenticatedUpdate({ update, receivedSecret: secret, expectedSecret: secret }).status, "OK");
  assert.equal(plane.ingestAuthenticatedUpdate({ update, receivedSecret: secret, expectedSecret: secret }).status, "DUPLICATE");
  const mismatch = { ...update, message: { ...update.message, text: "changed" } };
  assert.equal(plane.ingestAuthenticatedUpdate({ update: mismatch, receivedSecret: secret, expectedSecret: secret }).status, "BLOCKED");
});

test("strict review requires allowlisted architect and a private chat", () => {
  const { plane } = makePlane();
  assert.equal(plane.createClaimReviewRequest({ projection, actorTelegramUserId: "999", chatId: "123456" }).status, "DENY");
  const request = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  assert.equal(request.status, "PENDING");
});

test("reject/contest require a reason and a valid proof before persistence", async () => {
  const { plane, persisted } = makePlane();
  const { request } = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const base = {
    requestId: request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    targetDigest: request.targetDigest,
    evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest,
    policyVersion: request.policyVersion,
    proof: "trusted-proof",
  };
  assert.equal((await plane.resolveClaimReview({ ...base, decision: "REJECT" })).reason, "TELEGRAM_DECISION_REASON_REQUIRED");
  const result = await plane.resolveClaimReview({ ...base, decision: "REJECT", reason: "Source is contradicted." });
  assert.equal(result.status, "OK");
  assert.equal(persisted.length, 1);
});

test("approval is bound to target and policy digests", async () => {
  const { plane } = makePlane();
  const { request } = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const result = await plane.resolveClaimReview({
    requestId: request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: `sha256:${"d".repeat(64)}`,
    evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest,
    policyVersion: request.policyVersion,
    proof: "trusted-proof",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "TELEGRAM_APPROVAL_BINDING_MISMATCH");
});

test("missing trusted verifier fails closed", async () => {
  const { plane } = makePlane({ verifyApproval: undefined });
  const { request } = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const result = await plane.resolveClaimReview({
    requestId: request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: request.targetDigest,
    evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest,
    policyVersion: request.policyVersion,
    proof: "trusted-proof",
  });
  assert.equal(result.status, "DENY");
  assert.equal(result.reason, "TELEGRAM_TRUSTED_APPROVAL_VERIFIER_UNAVAILABLE");
});

test("expired approval cannot be accepted", async () => {
  const { plane, advance } = makePlane();
  const { request } = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456", ttlMs: 1000 });
  advance(1001);
  const result = await plane.resolveClaimReview({
    requestId: request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: request.targetDigest,
    evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest,
    policyVersion: request.policyVersion,
    proof: "trusted-proof",
  });
  assert.equal(result.status, "DENY");
  assert.equal(result.reason, "TELEGRAM_APPROVAL_REQUEST_EXPIRED");
});

test("successful decision is persisted once and exact replay is idempotent", async () => {
  const { plane, persisted } = makePlane();
  const { request } = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const args = {
    requestId: request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: request.targetDigest,
    evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest,
    policyVersion: request.policyVersion,
    proof: "trusted-proof",
  };
  assert.equal((await plane.resolveClaimReview(args)).status, "OK");
  assert.equal((await plane.resolveClaimReview(args)).status, "DUPLICATE");
  assert.equal(persisted.length, 1);
});
