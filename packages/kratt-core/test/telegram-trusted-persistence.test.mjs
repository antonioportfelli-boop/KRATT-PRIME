import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { createTelegramApprovalSigningRequest } from "../src/telegram-approval-signing-request.mjs";
import { createTelegramExternalSignerAdapter } from "../../kratt-orchestrator/src/telegram-external-signer.mjs";
import { createTelegramControlPlane } from "../../kratt-orchestrator/src/telegram-control-plane.mjs";
import { createSqliteTelegramStore } from "../../kratt-orchestrator/src/telegram-sqlite-store.mjs";
import { createSqliteNonceStore } from "../src/sqlite-nonce-store.mjs";
import {
  canonicalTelegramApprovalPayload,
  createTrustedTelegramDecisionVerifier,
} from "../src/telegram-approval-verifier.mjs";

const secret = "test-webhook-secret";
const authority = "kratt.claim.review";
const projection = {
  claimId: "claim-telegram-01",
  claimDigest: `sha256:${"a".repeat(64)}`,
  evidenceSnapshotDigest: `sha256:${"b".repeat(64)}`,
  rootDigest: `sha256:${"c".repeat(64)}`,
};

function setup() {
  const database = new DatabaseSync(":memory:");
  const store = createSqliteTelegramStore(database);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const nowMs = Date.parse("2026-11-10T12:00:00.000Z");
  const key = {
    key_id: "telegram-review-key-1",
    approver_id: "123456",
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
    authorities: [authority],
  };
  const verifyApproval = createTrustedTelegramDecisionVerifier({
    trustedApprovalKeys: [key],
    now: () => nowMs,
    authority,
  });
  const plane = createTelegramControlPlane({
    now: () => new Date(nowMs).toISOString(),
    allowedArchitectUserIds: ["123456"],
    webhookSecret: secret,
    verifyApproval,
    store,
  });
  return { database, store, plane, privateKey, publicKey, nowMs };
}

function signedProof(request, privateKey, nowMs, overrides = {}) {
  const proof = {
    schema_version: "kratt-telegram-approval/v1",
    approval_id: "approval-telegram-0001",
    request_id: request.requestId,
    nonce: request.nonce,
    actor_telegram_user_id: request.actorTelegramUserId,
    chat_id: request.chatId,
    claim_id: request.claimId,
    target_digest: request.targetDigest,
    evidence_snapshot_digest: request.evidenceSnapshotDigest,
    root_digest: request.rootDigest,
    policy_version: request.policyVersion,
    decision: "APPROVE",
    reason: "",
    issued_at: new Date(nowMs).toISOString(),
    expires_at: request.expiresAt,
    approved_by: request.actorTelegramUserId,
    authority,
    key_id: "telegram-review-key-1",
    signature: "",
    ...overrides,
  };
  proof.signature = sign(null, Buffer.from(canonicalTelegramApprovalPayload(proof), "utf8"), privateKey).toString("base64url");
  return proof;
}

test("SQLite Telegram store durably deduplicates update IDs and persists unreviewed intake", async () => {
  const { store, plane } = setup();
  const update = {
    update_id: 701,
    message: { from: { id: 9 }, chat: { id: 9, type: "private" }, text: "untrusted claim from Telegram" },
  };
  const first = await plane.ingestAuthenticatedUpdate({ update, receivedSecret: secret });
  assert.equal(first.status, "OK");
  assert.equal(first.intake.reviewState, "UNREVIEWED");
  const duplicate = await plane.ingestAuthenticatedUpdate({ update, receivedSecret: secret });
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(store.snapshot().intakes.length, 1);
});

test("SQLite store blocks same Telegram update ID with a different payload digest", async () => {
  const { plane } = setup();
  const base = { update_id: 702, message: { from: { id: 9 }, chat: { id: 9, type: "private" }, text: "first" } };
  assert.equal((await plane.ingestAuthenticatedUpdate({ update: base, receivedSecret: secret })).status, "OK");
  const replay = { ...base, message: { ...base.message, text: "tampered replay" } };
  assert.equal((await plane.ingestAuthenticatedUpdate({ update: replay, receivedSecret: secret })).status, "BLOCKED");
});

test("Ed25519 signed architect decision is persisted with atomic one-time nonce consumption", async () => {
  const { store, plane, privateKey, nowMs } = setup();
  const pending = plane.createClaimReviewRequest({
    projection,
    actorTelegramUserId: "123456",
    chatId: "123456",
    chatType: "private",
  });
  assert.equal(pending.status, "PENDING");
  const proof = signedProof(pending.request, privateKey, nowMs);
  const result = await plane.resolveClaimReview({
    requestId: pending.request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    chatType: "private",
    decision: "APPROVE",
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    proof,
  });
  assert.equal(result.status, "OK");
  const snapshot = store.snapshot();
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.reviewRequests[0].state, "CONSUMED");
});

test("tampered Ed25519 decision is denied and review remains retryable", async () => {
  const { store, plane, privateKey, nowMs } = setup();
  const pending = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const proof = signedProof(pending.request, privateKey, nowMs, { decision: "REJECT" });
  const result = await plane.resolveClaimReview({
    requestId: pending.request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    proof,
  });
  assert.equal(result.status, "DENY");
  assert.equal(store.getReviewRequest(pending.request.requestId).state, "PENDING");
});

test("Telegram review verifier rejects forged, unknown-key, authority-swapped and expired proofs", () => {
  const { plane, privateKey, publicKey, nowMs } = setup();
  const pending = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const verifier = createTrustedTelegramDecisionVerifier({
    trustedApprovalKeys: [{
      key_id: "telegram-review-key-1",
      approver_id: "123456",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      authorities: [authority],
    }],
    now: () => nowMs,
  });
  const request = pending.request;
  const binding = {
    requestId: request.requestId,
    nonce: request.nonce,
    actorTelegramUserId: request.actorTelegramUserId,
    chatId: request.chatId,
    claimId: request.claimId,
    targetDigest: request.targetDigest,
    evidenceSnapshotDigest: request.evidenceSnapshotDigest,
    rootDigest: request.rootDigest,
    policyVersion: request.policyVersion,
    decision: "APPROVE",
    reason: "",
    expiresAt: request.expiresAt,
  };
  const valid = signedProof(request, privateKey, nowMs);
  assert.equal(verifier(valid, binding), true);

  const forged = { ...valid, reason: "tampered after signing" };
  assert.equal(verifier(forged, binding), false);

  const unknownKey = signedProof(request, privateKey, nowMs, { key_id: "untrusted-key" });
  assert.equal(verifier(unknownKey, binding), false);

  const wrongAuthority = signedProof(request, privateKey, nowMs, { authority: "other.authority" });
  assert.equal(verifier(wrongAuthority, binding), false);

  const expired = signedProof(request, privateKey, nowMs, {
    issued_at: new Date(nowMs - 6 * 60_000).toISOString(),
  });
  assert.equal(verifier(expired, binding), false);
});

test("file-backed Telegram intake and update deduplication survive database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kratt-telegram-store-"));
  const filename = join(directory, "telegram.sqlite");
  let database = new DatabaseSync(filename);
  try {
    let store = createSqliteTelegramStore(database);
    const update = {
      update_id: 9901,
      message: { from: { id: 9 }, chat: { id: 9, type: "private" }, text: "persist across process restart" },
    };
    const firstPlane = createTelegramControlPlane({
      now: () => "2026-11-10T12:00:00.000Z",
      allowedArchitectUserIds: ["123456"],
      webhookSecret: secret,
      persistDecision: async () => true,
      store,
    });
    assert.equal((await firstPlane.ingestAuthenticatedUpdate({ update, receivedSecret: secret })).status, "OK");
    database.close();

    database = new DatabaseSync(filename);
    store = createSqliteTelegramStore(database);
    assert.equal(store.snapshot().intakes.length, 1);
    const restartedPlane = createTelegramControlPlane({
      now: () => "2026-11-10T12:00:01.000Z",
      allowedArchitectUserIds: ["123456"],
      webhookSecret: secret,
      persistDecision: async () => true,
      store,
    });
    assert.equal((await restartedPlane.ingestAuthenticatedUpdate({ update, receivedSecret: secret })).status, "DUPLICATE");
  } finally {
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file-backed signed decision, audit and nonce remain consumed after database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kratt-telegram-approval-"));
  const filename = join(directory, "telegram.sqlite");
  let database = new DatabaseSync(filename);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const nowMs = Date.parse("2026-11-10T12:00:00.000Z");
  const key = {
    key_id: "telegram-review-key-1",
    approver_id: "123456",
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
    authorities: [authority],
  };
  try {
    let store = createSqliteTelegramStore(database);
    const verifier = createTrustedTelegramDecisionVerifier({ trustedApprovalKeys: [key], now: () => nowMs });
    const plane = createTelegramControlPlane({
      now: () => new Date(nowMs).toISOString(),
      allowedArchitectUserIds: ["123456"],
      webhookSecret: secret,
      verifyApproval: verifier,
      store,
    });
    const pending = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
    const proof = signedProof(pending.request, privateKey, nowMs);
    const result = await plane.resolveClaimReview({
      requestId: pending.request.requestId,
      actorTelegramUserId: "123456",
      chatId: "123456",
      decision: "APPROVE",
      targetDigest: pending.request.targetDigest,
      evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
      rootDigest: pending.request.rootDigest,
      policyVersion: pending.request.policyVersion,
      proof,
    });
    assert.equal(result.status, "OK");
    database.close();

    database = new DatabaseSync(filename);
    store = createSqliteTelegramStore(database);
    const snapshot = store.snapshot();
    assert.equal(snapshot.decisions.length, 1);
    assert.equal(snapshot.reviewRequests[0].state, "CONSUMED");
    assert.equal(snapshot.journal.some(event => event.type === "TELEGRAM_DECISION_PERSISTED"), true);
    const restartedVerifier = createTrustedTelegramDecisionVerifier({ trustedApprovalKeys: [key], now: () => nowMs });
    const restartedPlane = createTelegramControlPlane({
      now: () => new Date(nowMs).toISOString(),
      allowedArchitectUserIds: ["123456"],
      webhookSecret: secret,
      verifyApproval: restartedVerifier,
      store,
    });
    const replay = await restartedPlane.resolveClaimReview({
      requestId: pending.request.requestId,
      actorTelegramUserId: "123456",
      chatId: "123456",
      decision: "APPROVE",
      targetDigest: pending.request.targetDigest,
      evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
      rootDigest: pending.request.rootDigest,
      policyVersion: pending.request.policyVersion,
      proof,
    });
    assert.equal(replay.status, "DUPLICATE");
    assert.equal(createSqliteNonceStore(database).consume(
      proof.key_id, proof.nonce, proof.approval_id, proof.expires_at, nowMs
    ), false);
  } finally {
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external Ed25519 signing request produces a verifier-accepted bound proof", async () => {
  const { plane, privateKey, publicKey, nowMs } = setup();
  const pending = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const intent = {
    status: "PENDING_SIGNATURE",
    requestId: pending.request.requestId,
    actorTelegramUserId: pending.request.actorTelegramUserId,
    chatId: pending.request.chatId,
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    decision: "APPROVE",
    reason: "",
  };
  const signingRequest = createTelegramApprovalSigningRequest({
    request: pending.request,
    intent,
    keyId: "telegram-review-key-1",
    approvedBy: "123456",
    issuedAt: new Date(nowMs).toISOString(),
  });
  assert.equal(signingRequest.algorithm, "Ed25519");
  assert.equal(signingRequest.privateKeyHandling, "EXTERNAL_SIGNER_ONLY");
  const proof = {
    ...signingRequest.proof,
    signature: sign(null, Buffer.from(signingRequest.payload, "utf8"), privateKey).toString("base64url"),
  };
  const result = await plane.resolveClaimReview({
    requestId: pending.request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    proof,
  });
  assert.equal(result.status, "OK");
});

test("external signing request refuses changed intent digests and wrong approver", () => {
  const { plane, nowMs } = setup();
  const pending = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const intent = {
    status: "PENDING_SIGNATURE",
    requestId: pending.request.requestId,
    actorTelegramUserId: pending.request.actorTelegramUserId,
    chatId: pending.request.chatId,
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    decision: "APPROVE",
    reason: "",
  };
  assert.throws(() => createTelegramApprovalSigningRequest({
    request: pending.request,
    intent: { ...intent, targetDigest: `sha256:${"9".repeat(64)}` },
    keyId: "telegram-review-key-1",
    approvedBy: "123456",
    issuedAt: new Date(nowMs).toISOString(),
  }), /TELEGRAM_APPROVAL_SIGNING_REQUEST_INVALID/);
  assert.throws(() => createTelegramApprovalSigningRequest({
    request: pending.request,
    intent,
    keyId: "telegram-review-key-1",
    approvedBy: "999999",
    issuedAt: new Date(nowMs).toISOString(),
  }), /TELEGRAM_APPROVAL_SIGNING_REQUEST_INVALID/);
});

test("external signer adapter signs only the request-bound payload and locally verifies it", async () => {
  const { plane, privateKey, nowMs } = setup();
  const pending = plane.createClaimReviewRequest({ projection, actorTelegramUserId: "123456", chatId: "123456" });
  const intent = {
    status: "PENDING_SIGNATURE",
    requestId: pending.request.requestId,
    actorTelegramUserId: "123456",
    chatId: pending.request.chatId,
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    decision: "APPROVE",
    reason: "",
  };
  const adapter = createTelegramExternalSignerAdapter({
    keyId: "telegram-review-key-1",
    approvedBy: "123456",
    verifyApproval: async (proof, binding) => {
      const verifier = createTrustedTelegramDecisionVerifier({
        trustedApprovalKeys: [{
          key_id: "telegram-review-key-1",
          approver_id: "123456",
          public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
          authorities: [authority],
        }],
        now: () => nowMs,
      });
      return verifier(proof, binding);
    },
    signer: {
      async signEd25519({ payload }) {
        return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
      },
    },
  });
  const signed = await adapter.signIntent({
    request: pending.request,
    intent,
    issuedAt: new Date(nowMs).toISOString(),
  });
  assert.equal(signed.status, "OK");
  const result = await plane.resolveClaimReview({
    requestId: pending.request.requestId,
    actorTelegramUserId: "123456",
    chatId: "123456",
    decision: "APPROVE",
    targetDigest: pending.request.targetDigest,
    evidenceSnapshotDigest: pending.request.evidenceSnapshotDigest,
    rootDigest: pending.request.rootDigest,
    policyVersion: pending.request.policyVersion,
    proof: signed.proof,
  });
  assert.equal(result.status, "OK");
});
