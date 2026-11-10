import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTelegramControlPlane } from "../../kratt-orchestrator/src/telegram-control-plane.mjs";
import { createSqliteTelegramStore } from "../../kratt-orchestrator/src/telegram-sqlite-store.mjs";
import { createTelegramReviewWidgetService } from "../../kratt-orchestrator/src/telegram-review-service.mjs";
import { createTelegramWidgetQueryHandler } from "../../kratt-orchestrator/src/telegram-widget-query-handler.mjs";
import { normalizeTelegramUpdate } from "../../kratt-orchestrator/src/telegram-control-plane.mjs";
import { createTrustedTelegramDecisionVerifier } from "../src/telegram-approval-verifier.mjs";
import { createTelegramApprovalSigningRequest } from "../src/telegram-approval-signing-request.mjs";
import { createTelegramEvidenceReporter, renderTelegramEvidenceReport } from "../../kratt-orchestrator/src/telegram-rich-report.mjs";
import { renderClaimReviewWidget } from "../../kratt-orchestrator/src/telegram-review-widget.mjs";
import { createTelegramBotApiClient } from "../../kratt-orchestrator/src/telegram-bot-api-client.mjs";

const digest = letter => `sha256:${letter.repeat(64)}`;
const projection = {
  claimId: "claim-widget-1",
  claimText: "<img src=x onerror=alert(1)>",
  claimStatus: "UNREVIEWED",
  claimDigest: digest("a"),
  evidenceSnapshotDigest: digest("b"),
  rootDigest: digest("c"),
  sourceRefs: [{ publisher: "Example Source", excerpt: "<script>alert(1)</script>", digest: digest("d") }],
  evidenceLinks: [
    { relation: "SUPPORTS", publisher: "Support Source", excerpt: "Supporting excerpt", digest: digest("e") },
    { relation: "CONTRADICTS", publisher: "Contradiction Source", excerpt: "Contradicting excerpt", digest: digest("f") },
  ],
  contradictions: [{ summary: "Potential mismatch" }],
};
const request = {
  requestId: "request-widget-1",
  claimId: projection.claimId,
  targetDigest: projection.claimDigest,
  evidenceSnapshotDigest: projection.evidenceSnapshotDigest,
  rootDigest: projection.rootDigest,
  chatType: "private",
};

test("Claim Review Widget is self-contained, escaped, bounded and intent-only", () => {
  const widget = renderClaimReviewWidget({ projection, request });
  assert.equal(widget.allowQueries, true);
  assert.equal(widget.isShared, false);
  assert.equal(widget.chatData.includes(request.requestId), true);
  assert.equal(widget.html.includes("<img src=x"), false);
  assert.equal(widget.html.includes("<script>alert(1)</script>"), false);
  assert.equal(widget.html.includes("intent:APPROVE"), true);
  assert.equal(widget.html.includes("intent:REJECT:SOURCE_CONTRADICTED"), true);
  assert.equal(widget.html.includes("separate signed confirmation"), true);
  assert.ok(widget.htmlBytes <= 32768);
  assert.ok(widget.compressedBytes <= 4096);
});

test("Claim Review Widget refuses mismatched snapshots and non-private chats", () => {
  assert.throws(() => renderClaimReviewWidget({
    projection,
    request: { ...request, targetDigest: digest("9") },
  }), /TELEGRAM_REVIEW_WIDGET_PROJECTION_INVALID/);
  assert.throws(() => renderClaimReviewWidget({
    projection,
    request: { ...request, chatType: "group" },
  }), /TELEGRAM_REVIEW_WIDGET_PROJECTION_INVALID/);
});

test("Bot API client sends a protected private review widget without activating a webhook", async () => {
  const calls = [];
  const client = createTelegramBotApiClient({
    token: "123456789:local-test-token-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 44, chat: { id: 123456 } } }) };
    },
  });
  const widget = renderClaimReviewWidget({ projection, request });
  const message = await client.sendClaimReviewWidget({
    chatId: 123456,
    chatType: "private",
    html: widget.html,
    chatData: widget.chatData,
    caption: "KRATT claim review",
  });
  assert.equal(message.message_id, 44);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith("/sendWidget"), true);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.chat_id, 123456);
  assert.equal(payload.allow_queries, true);
  assert.equal(payload.is_shared, false);
  assert.equal(payload.protect_content, true);
});

test("Bot API client refuses group widget sends and oversized widget HTML", async () => {
  const client = createTelegramBotApiClient({
    token: "123456789:local-test-token-secret",
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await assert.rejects(client.sendClaimReviewWidget({
    chatId: -100123,
    chatType: "group",
    html: "<p>review</p>",
    chatData: "{}",
  }), /TELEGRAM_WIDGET_PRIVATE_CHAT_REQUIRED/);
  await assert.rejects(client.sendClaimReviewWidget({
    chatId: 123456,
    chatType: "private",
    html: "<p>" + "x".repeat(40_000) + "</p>",
    chatData: "{}",
  }), /TELEGRAM_WIDGET_HTML_TOO_LARGE/);
});

test("Bot API client answers widget queries and edits bot-owned chat state", async () => {
  const calls = [];
  const client = createTelegramBotApiClient({
    token: "123456789:local-test-token-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  });
  await client.answerWidgetQuery("query-1", "Intent received.");
  await client.editMessageWidgetData({ chatId: 123456, messageId: 44, chatData: JSON.stringify({ status: "PENDING_SIGNATURE" }) });
  assert.equal(calls[0].url.endsWith("/answerWidgetQuery"), true);
  assert.equal(calls[0].body.widget_query_id, "query-1");
  assert.equal(calls[1].url.endsWith("/editMessageWidgetData"), true);
  assert.equal(calls[1].body.message_id, 44);
});

test("Bot API client sanitizes rejected API errors and never returns the token", async () => {
  const token = "123456789:local-test-token-secret";
  const client = createTelegramBotApiClient({
    token,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: "unauthorized" }) }),
  });
  await assert.rejects(client.answerWidgetQuery("query-1"), error => {
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message, "TELEGRAM_API_REJECTED:answerWidgetQuery:401");
    return true;
  });
});

test("review widget service binds sent message to a persisted pending request", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createSqliteTelegramStore(database);
    const controlPlane = createTelegramControlPlane({
      now: () => "2026-11-10T12:00:00.000Z",
      allowedArchitectUserIds: ["123456"],
      webhookSecret: "local-test-webhook-secret",
      store,
    });
    const service = createTelegramReviewWidgetService({
      controlPlane,
      store,
      botApiClient: {
        async sendClaimReviewWidget() {
          return { message_id: 91, chat: { id: 123456 } };
        },
      },
    });
    const result = await service.send({
      projection,
      actorTelegramUserId: "123456",
      chatId: "123456",
      chatType: "private",
    });
    assert.equal(result.status, "OK");
    assert.equal(result.reason, "TELEGRAM_REVIEW_WIDGET_SENT_PENDING_SIGNATURE");
    const mapping = store.getReviewRequestForMessage("123456", 91);
    assert.equal(mapping.request.requestId, result.requestId);
    assert.equal(mapping.state, "PENDING");
  } finally { database.close(); }
});

test("review widget service refuses group contexts and cancels when send fails", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createSqliteTelegramStore(database);
    const controlPlane = createTelegramControlPlane({
      now: () => "2026-11-10T12:00:00.000Z",
      allowedArchitectUserIds: ["123456"],
      webhookSecret: "local-test-webhook-secret",
      store,
    });
    let sends = 0;
    const service = createTelegramReviewWidgetService({
      controlPlane,
      store,
      botApiClient: {
        async sendClaimReviewWidget() { sends += 1; throw new Error("transport unavailable"); },
      },
    });
    const denied = await service.send({
      projection,
      actorTelegramUserId: "123456",
      chatId: "-100123",
      chatType: "group",
    });
    assert.equal(denied.status, "DENY");
    assert.equal(sends, 0);

    const failed = await service.send({
      projection,
      actorTelegramUserId: "123456",
      chatId: "123456",
      chatType: "private",
    });
    assert.equal(failed.status, "ERROR");
    const requests = store.snapshot().reviewRequests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].state, "CANCELLED");
  } finally { database.close(); }
});

test("WidgetQuery intent proceeds to a separate Ed25519 signature before final decision", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createSqliteTelegramStore(database);
    const calls = [];
    const botApiClient = {
      async sendClaimReviewWidget() { return { message_id: 111 }; },
      async answerWidgetQuery(id, data) { calls.push({ method: "answer", id, data }); return true; },
      async editMessageWidgetData(args) { calls.push({ method: "edit", ...args }); return true; },
    };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const nowMs = Date.parse("2026-11-10T12:00:00.000Z");
    const authority = "kratt.claim.review";
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
    const handleWidgetQuery = createTelegramWidgetQueryHandler({
      store,
      botApiClient,
      now: () => "2026-11-10T12:00:01.000Z",
    });
    const plane = createTelegramControlPlane({
      now: () => new Date(nowMs).toISOString(),
      allowedArchitectUserIds: ["123456"],
      webhookSecret: "local-test-webhook-secret",
      handleWidgetQuery,
      verifyApproval,
      store,
    });
    const service = createTelegramReviewWidgetService({ controlPlane: plane, store, botApiClient });
    const sent = await service.send({ projection, actorTelegramUserId: "123456", chatId: "123456" });
    assert.equal(sent.status, "OK");

    const update = {
      update_id: 1201,
      widget_query: {
        id: "widget-query-1",
        from: { id: 123456 },
        chat: { id: 123456, type: "private" },
        message_id: 111,
        type: { type: "data" },
        data: "intent:APPROVE",
      },
    };
    const normalized = normalizeTelegramUpdate(update);
    assert.equal(normalized.status, "OK");
    assert.equal(normalized.envelope.updateKind, "widget_query");
    assert.equal(normalized.envelope.widgetQueryType, "data");
    const result = await plane.ingestAuthenticatedUpdate({ update, receivedSecret: "local-test-webhook-secret" });
    assert.equal(result.status, "OK");
    assert.equal(result.requiresSignedConfirmation, true);
    const storedIntent = store.getDecisionIntent(sent.requestId);
    assert.equal(storedIntent.state, "PENDING_SIGNATURE");
    assert.equal(storedIntent.intent.decision, "APPROVE");
    assert.equal(store.snapshot().decisions.length, 0);
    assert.equal(calls.some(call => call.method === "answer"), true);
    assert.equal(calls.some(call => call.method === "edit"), true);

    const conflictingIntent = await plane.ingestAuthenticatedUpdate({
      update: {
        update_id: 1204,
        widget_query: {
          id: "widget-query-conflict",
          from: { id: 123456 },
          chat: { id: 123456, type: "private" },
          message_id: 111,
          type: { type: "data" },
          data: "intent:REJECT:SOURCE_CONTRADICTED",
        },
      },
      receivedSecret: "local-test-webhook-secret",
    });
    assert.equal(conflictingIntent.status, "BLOCKED");
    assert.equal(store.getDecisionIntent(sent.requestId).intent.decision, "APPROVE");

    const request = store.getReviewRequest(sent.requestId).request;
    const signingRequest = createTelegramApprovalSigningRequest({
      request,
      intent: storedIntent.intent,
      keyId: key.key_id,
      approvedBy: key.approver_id,
      issuedAt: new Date(nowMs).toISOString(),
    });
    const proof = {
      ...signingRequest.proof,
      signature: sign(null, Buffer.from(signingRequest.payload, "utf8"), privateKey).toString("base64url"),
    };
    const finalDecision = await plane.resolveClaimReview({
      requestId: request.requestId,
      actorTelegramUserId: "123456",
      chatId: "123456",
      decision: "APPROVE",
      targetDigest: request.targetDigest,
      evidenceSnapshotDigest: request.evidenceSnapshotDigest,
      rootDigest: request.rootDigest,
      policyVersion: request.policyVersion,
      proof,
    });
    assert.equal(finalDecision.status, "OK");
    assert.equal(store.getDecisionIntent(sent.requestId).state, "SIGNED");
    assert.equal(store.snapshot().decisions.length, 1);
  } finally { database.close(); }
});

test("WidgetQuery rejects wrong actor and unsupported shared-widget decision contexts", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createSqliteTelegramStore(database);
    let sharedAcknowledged = false;
    const botApiClient = {
      async sendClaimReviewWidget() { return { message_id: 112 }; },
      async answerWidgetQuery() { sharedAcknowledged = true; return true; },
      async editMessageWidgetData() { return true; },
    };
    const handler = createTelegramWidgetQueryHandler({ store, botApiClient });
    const plane = createTelegramControlPlane({
      now: () => "2026-11-10T12:00:00.000Z",
      allowedArchitectUserIds: ["123456"],
      webhookSecret: "local-test-webhook-secret",
      handleWidgetQuery: handler,
      store,
    });
    const service = createTelegramReviewWidgetService({ controlPlane: plane, store, botApiClient });
    const sent = await service.send({ projection, actorTelegramUserId: "123456", chatId: "123456" });
    assert.equal(sent.status, "OK");

    const wrongActor = await plane.ingestAuthenticatedUpdate({
      receivedSecret: "local-test-webhook-secret",
      update: {
        update_id: 1202,
        widget_query: {
          id: "widget-query-wrong-actor",
          from: { id: 999999 },
          chat: { id: 123456, type: "private" },
          message_id: 112,
          type: { type: "data" },
          data: "intent:APPROVE",
        },
      },
    });
    assert.equal(wrongActor.status, "DENY");
    assert.equal(store.getDecisionIntent(sent.requestId), null);

    const shared = await plane.ingestAuthenticatedUpdate({
      receivedSecret: "local-test-webhook-secret",
      update: {
        update_id: 1203,
        shared_widget_query: {
          id: "shared-widget-query-unsupported",
          from: { id: 123456 },
          widget_id: "shared-widget-1",
          type: { type: "data" },
          data: "intent:APPROVE",
        },
      },
    });
    assert.equal(shared.status, "DENY");
    assert.equal(sharedAcknowledged, true);
  } finally { database.close(); }
});

test("Rich evidence report escapes untrusted text and separates evidence integrity from truth", () => {
  const report = renderTelegramEvidenceReport({
    projection: {
      ...projection,
      claimText: "<script>alert(1)</script> Claim",
      claimStatus: "UNREVIEWED",
      sourceRefs: [{
        publisher: "Publisher <img>",
        title: "Source title",
        canonicalUrl: "javascript:alert(1)",
        excerpt: "<svg onload=alert(1)> untrusted excerpt",
        digest: digest("d"),
        capturedAt: "2026-11-10T12:00:00.000Z",
      }],
      evidenceLinks: [
        { relation: "SUPPORTS", evidenceId: "ev-1", summary: "Support evidence" },
        { relation: "CONTRADICTS", evidenceId: "ev-2", summary: "Contradiction evidence" },
      ],
      contradictions: [{ summary: "Potential contradiction" }],
    },
    generatedAt: "2026-11-10T12:00:00.000Z",
  });
  assert.equal(report.markdown.includes("<script>"), false);
  assert.equal(report.markdown.includes("&lt;script&gt;"), true);
  assert.equal(report.markdown.includes("javascript:"), false);
  assert.equal(report.markdown.includes("Source integrity and claim truth are separate"), true);
  assert.equal(report.markdown.includes("Supporting links: 1"), true);
  assert.equal(report.markdown.includes("Contradicting links: 1"), true);
  assert.ok(report.bytes <= 32768);
});

test("Rich evidence reporter sends persistent Telegram Rich Message through the API client", async () => {
  const sent = [];
  const reporter = createTelegramEvidenceReporter({
    botApiClient: {
      async sendRichMessage(args) {
        sent.push(args);
        return { message_id: 222 };
      },
    },
  });
  const result = await reporter.send({ chatId: 123456, projection, generatedAt: "2026-11-10T12:00:00.000Z" });
  assert.equal(result.status, "OK");
  assert.equal(result.messageId, 222);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].protectContent, true);
  assert.equal(sent[0].markdown.includes("KRATT PRIME — Evidence Review"), true);
});

test("Bot API client sends a persistent Rich Message, not an ephemeral draft", async () => {
  const calls = [];
  const client = createTelegramBotApiClient({
    token: "123456789:local-test-token-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 333 } }) };
    },
  });
  const result = await client.sendRichMessage({
    chatId: 123456,
    markdown: "# KRATT Evidence Report",
    protectContent: true,
  });
  assert.equal(result.message_id, 333);
  assert.equal(calls[0].url.endsWith("/sendRichMessage"), true);
  assert.deepEqual(calls[0].body.rich_message, { markdown: "# KRATT Evidence Report" });
  assert.equal(calls[0].body.protect_content, true);
});
