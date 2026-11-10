import { createHash, randomUUID } from "node:crypto";

const REASONS = Object.freeze({
  "REJECT:SOURCE_CONTRADICTED": "The claim is contradicted by the cited evidence.",
  "REJECT:SOURCE_UNVERIFIED": "The cited source is not independently verified.",
  "REJECT:CLAIM_OUT_OF_SCOPE": "The claim is outside the agreed review scope.",
  "CONTEST:INSUFFICIENT_CONTEXT": "The evidence does not provide sufficient context.",
  "CONTEST:CONFLICTING_EVIDENCE": "The evidence contains unresolved contradictions.",
  "ABSTAIN:NEED_MORE_EVIDENCE": "More independent evidence is required before a decision.",
});

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function parseIntent(data) {
  if (data === "intent:APPROVE") return { decision: "APPROVE", reasonCode: null, reason: "" };
  if (typeof data !== "string" || !data.startsWith("intent:")) return null;
  const parts = data.slice(7).split(":");
  if (parts.length !== 2) return null;
  const [decision, reasonCode] = parts;
  const reason = REASONS[`${decision}:${reasonCode}`];
  if (!reason || !["REJECT", "CONTEST", "ABSTAIN"].includes(decision)) return null;
  return { decision, reasonCode, reason };
}

function auditEvent(intent, now) {
  const event = {
    eventId: randomUUID(),
    correlationId: intent.requestId,
    occurredAt: now,
    type: "TELEGRAM_DECISION_INTENT_RECORDED",
    payloadDigest: digest({
      requestId: intent.requestId,
      actorTelegramUserId: intent.actorTelegramUserId,
      decision: intent.decision,
      reasonCode: intent.reasonCode,
    }),
  };
  return Object.freeze(event);
}

/**
 * WidgetQuery records a human decision intent only. It cannot create an
 * approval artifact or authorize a KRATT write. A separate trusted signer
 * must sign the exact request-bound decision before resolveClaimReview.
 */
export function createTelegramWidgetQueryHandler({ store, botApiClient, now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.getReviewRequestForMessage !== "function" ||
      typeof store.createDecisionIntent !== "function" || typeof store.getDecisionIntent !== "function") {
    throw new TypeError("TELEGRAM_WIDGET_QUERY_STORE_REQUIRED");
  }
  if (!botApiClient || typeof botApiClient.answerWidgetQuery !== "function" ||
      typeof botApiClient.editMessageWidgetData !== "function") {
    throw new TypeError("TELEGRAM_WIDGET_QUERY_BOT_CLIENT_REQUIRED");
  }
  if (typeof now !== "function") throw new TypeError("TELEGRAM_WIDGET_QUERY_CLOCK_REQUIRED");

  async function answer(queryId, message) {
    if (typeof queryId !== "string" || queryId.length < 1) return false;
    try { await botApiClient.answerWidgetQuery(queryId, message); return true; } catch { return false; }
  }

  return async function handleTelegramWidgetQuery({ envelope } = {}) {
    if (!envelope || !["widget_query","shared_widget_query"].includes(envelope.updateKind)) {
      return Object.freeze({ status: "DENY", reason: "TELEGRAM_WIDGET_QUERY_CONTEXT_UNSUPPORTED" });
    }
    const { widgetQueryId, widgetQueryData, actorTelegramUserId, chatId, chatType, widgetMessageId } = envelope;
    if (envelope.updateKind === "shared_widget_query") {
      await answer(widgetQueryId, "Shared-widget review decisions are not supported in KRATT V1.");
      return Object.freeze({ status: "DENY", reason: "TELEGRAM_SHARED_WIDGET_REVIEW_UNSUPPORTED" });
    }
    if (chatType !== "private" || !chatId || !Number.isSafeInteger(widgetMessageId) || widgetMessageId < 1) {
      await answer(widgetQueryId, "Review decisions are accepted only in the assigned private chat.");
      return Object.freeze({ status: "DENY", reason: "TELEGRAM_WIDGET_PRIVATE_CONTEXT_REQUIRED" });
    }
    const mapping = store.getReviewRequestForMessage(chatId, widgetMessageId);
    if (!mapping) {
      await answer(widgetQueryId, "This review widget is not linked to an active KRATT request.");
      return Object.freeze({ status: "NOT_FOUND", reason: "TELEGRAM_WIDGET_REVIEW_MAPPING_NOT_FOUND" });
    }
    const request = mapping.request;
    if (mapping.state !== "PENDING" || request.actorTelegramUserId !== actorTelegramUserId ||
        request.chatId !== chatId || request.chatType !== "private") {
      await answer(widgetQueryId, "This review request is not pending for this Telegram account.");
      return Object.freeze({ status: "DENY", reason: "TELEGRAM_WIDGET_REVIEW_ACTOR_OR_STATE_MISMATCH" });
    }
    const action = parseIntent(widgetQueryData);
    if (!action) {
      await answer(widgetQueryId, "Unsupported review action. Choose one of the displayed options.");
      return Object.freeze({ status: "REJECTED", reason: "TELEGRAM_WIDGET_ACTION_INVALID" });
    }

    let createdAt;
    try {
      createdAt = now();
      if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new Error("clock");
    } catch {
      await answer(widgetQueryId, "KRATT's trusted clock is unavailable. Try again later.");
      return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_TRUSTED_CLOCK_UNAVAILABLE" });
    }

    const intent = Object.freeze({
      schemaVersion: "kratt-telegram-decision-intent/v1",
      intentId: randomUUID(),
      requestId: request.requestId,
      widgetQueryId,
      actorTelegramUserId,
      chatId,
      messageId: widgetMessageId,
      decision: action.decision,
      reasonCode: action.reasonCode,
      reason: action.reason,
      targetDigest: request.targetDigest,
      evidenceSnapshotDigest: request.evidenceSnapshotDigest,
      rootDigest: request.rootDigest,
      policyVersion: request.policyVersion,
      createdAt,
      status: "PENDING_SIGNATURE",
      signedApprovalRequired: true,
    });

    const stored = store.createDecisionIntent(intent, auditEvent(intent, createdAt));
    if (!stored || !["CREATED", "DUPLICATE"].includes(stored.status)) {
      await answer(widgetQueryId, "KRATT could not persist this intent. No decision was recorded.");
      return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_INTENT_PERSISTENCE_FAILED" });
    }
    const persistedIntent = stored.intent ?? intent;
    const responseText = "Intent recorded. Complete the separate Ed25519 signed confirmation in KRATT.";
    if (!await answer(widgetQueryId, responseText)) {
      return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_QUERY_ANSWER_FAILED" });
    }
    const chatData = JSON.stringify({
      schemaVersion: "kratt-telegram-widget-state/v1",
      requestId: request.requestId,
      intentId: persistedIntent.intentId,
      status: "PENDING_SIGNATURE",
      decision: persistedIntent.decision,
      reasonCode: persistedIntent.reasonCode,
    });
    try {
      await botApiClient.editMessageWidgetData({ chatId, messageId: widgetMessageId, chatData });
    } catch {
      return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_STATE_UPDATE_FAILED" });
    }
    return Object.freeze({
      status: "OK",
      reason: stored.status === "DUPLICATE" ? "TELEGRAM_DECISION_INTENT_ALREADY_RECORDED" : "TELEGRAM_DECISION_INTENT_RECORDED",
      intentId: persistedIntent.intentId,
      decision: persistedIntent.decision,
      requiresSignedConfirmation: true,
    });
  };
}
