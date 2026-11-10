import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const DECISIONS = Object.freeze(["APPROVE", "REJECT", "CONTEST", "ABSTAIN"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("TELEGRAM_PAYLOAD_NOT_CANONICAL");
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function outcome(status, reason, extra = {}) {
  return Object.freeze({ status, reason, ...extra });
}

export function verifyTelegramWebhookSecret(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" ||
      received.length < 1 || expected.length < 1) return false;
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (receivedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(receivedBytes, expectedBytes);
}

/**
 * Normalize only the stable outer envelope. Message text and all nested
 * Telegram payload fields remain untrusted data; no command is executed here.
 */
export function normalizeTelegramUpdate(update) {
  if (!update || typeof update !== "object" || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return outcome("REJECTED", "TELEGRAM_UPDATE_ENVELOPE_INVALID");
  }

  const candidates = ["message", "channel_post", "edited_message", "callback_query", "business_message", "widget_query", "shared_widget_query"];
  const kind = candidates.find(key => update[key] && typeof update[key] === "object");
  if (!kind) return outcome("REJECTED", "TELEGRAM_UPDATE_KIND_UNSUPPORTED");

  const item = update[kind];
  const from = kind === "callback_query" ? item.from : item.from;
  const chat = kind === "callback_query" ? item.message?.chat : item.chat;
  const widgetQuery = kind === "widget_query" || kind === "shared_widget_query";
  const text = kind === "callback_query" || widgetQuery ? null : (typeof item.text === "string" ? item.text :
    typeof item.caption === "string" ? item.caption : null);

  return outcome("OK", "TELEGRAM_UPDATE_NORMALIZED", {
    envelope: frozen({
      schemaVersion: "kratt-telegram-update/v1",
      updateId: update.update_id,
      updateKind: kind,
      actorTelegramUserId: Number.isSafeInteger(from?.id) ? String(from.id) : null,
      chatId: Number.isSafeInteger(chat?.id) ? String(chat.id) : null,
      chatType: typeof chat?.type === "string" ? chat.type :
        (typeof item.chat_type === "string" ? item.chat_type : null),
      text,
      callbackQueryId: kind === "callback_query" && typeof item.id === "string" ? item.id : null,
      widgetQueryId: widgetQuery && typeof item.id === "string" ? item.id : null,
      widgetQueryData: widgetQuery && typeof item.data === "string" ? item.data : null,
      widgetMessageId: widgetQuery && Number.isSafeInteger(item.message_id) ? item.message_id : null,
      widgetId: widgetQuery && typeof item.widget_id === "string" ? item.widget_id : null,
      payloadDigest: digest(update),
    }),
  });
}

/**
 * Local, dependency-injected Telegram control-plane kernel.
 * No HTTP client, token, webhook listener, persistence backend, or Telegram
 * network access is created by this module.
 */
export function createTelegramControlPlane({
  now = () => new Date().toISOString(),
  allowedArchitectUserIds = [],
  webhookSecret,
  verifyApproval,
  handleWidgetQuery,
  store,
  persistIntake,
  persistDecision,
} = {}) {
  if (typeof now !== "function") throw new TypeError("TELEGRAM_TRUSTED_CLOCK_REQUIRED");
  if (!Array.isArray(allowedArchitectUserIds) ||
      !allowedArchitectUserIds.every(id => typeof id === "string" && /^[0-9]{1,24}$/.test(id))) {
    throw new TypeError("TELEGRAM_ARCHITECT_ALLOWLIST_INVALID");
  }
  if (store && (!["claimUpdate","persistIntake","completeUpdate","releaseUpdate","saveReviewRequest","getReviewRequest","getDecision","claimReviewRequest","releaseReviewRequest","cancelReviewRequest","expireReviewRequest","persistDecision","appendAuditEvent","snapshot"].every(key => typeof store[key] === "function"))) {
    throw new TypeError("TELEGRAM_DURABLE_STORE_INVALID");
  }
  if (handleWidgetQuery !== undefined && typeof handleWidgetQuery !== "function") throw new TypeError("TELEGRAM_WIDGET_QUERY_HANDLER_INVALID");
  const saveIntake = persistIntake ?? store?.persistIntake?.bind(store);
  const saveDecision = persistDecision ?? store?.persistDecision?.bind(store);
  if (typeof saveIntake !== "function" || typeof saveDecision !== "function") throw new TypeError("TELEGRAM_PERSISTENCE_ADAPTER_REQUIRED");

  const architects = new Set(allowedArchitectUserIds);
  const configuredWebhookSecret = typeof webhookSecret === "string" && webhookSecret.length > 0 ? webhookSecret : null;
  const updates = new Map();
  const intakes = [];
  const requests = new Map();
  const decisions = new Map();
  const journal = [];

  function timestamp() {
    const value = now();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new TypeError("TELEGRAM_TRUSTED_CLOCK_UNAVAILABLE");
    }
    return value;
  }

  function buildAuditEvent(type, payload, correlationId) {
    const body = {
      sequence: journal.length + 1,
      eventId: randomUUID(),
      correlationId,
      occurredAt: timestamp(),
      type,
      payloadDigest: digest(payload),
      previousHash: journal.at(-1)?.hash ?? null,
    };
    body.hash = digest(body);
    return frozen(body);
  }

  function emit(type, payload, correlationId) {
    const body = buildAuditEvent(type, payload, correlationId);
    journal.push(body);
    if (store && store.appendAuditEvent(body) !== true) throw new Error("TELEGRAM_AUDIT_PERSISTENCE_FAILED");
    return body;
  }

  async function ingestAuthenticatedUpdate({ update, receivedSecret } = {}) {
    if (!configuredWebhookSecret || !verifyTelegramWebhookSecret(receivedSecret, configuredWebhookSecret)) {
      return outcome("DENY", "TELEGRAM_WEBHOOK_AUTHENTICATION_FAILED");
    }
    const normalized = normalizeTelegramUpdate(update);
    if (normalized.status !== "OK") return normalized;
    const item = normalized.envelope;
    const correlationId = `telegram-update-${item.updateId}`;
    const record = frozen({ ...item, receivedAt: timestamp(), correlationId, authenticationStatus: "VERIFIED" });
    let leaseToken = null;
    if (store) {
      const claim = store.claimUpdate(item.updateId, item.payloadDigest, record.receivedAt, Date.parse(record.receivedAt));
      if (claim.status === "DUPLICATE") return outcome("DUPLICATE", "TELEGRAM_UPDATE_ALREADY_PROCESSED", { updateId: item.updateId, original: claim.result });
      if (claim.status === "PENDING") return outcome("PENDING", "TELEGRAM_UPDATE_PROCESSING", { updateId: item.updateId });
      if (claim.status === "MISMATCH") {
        emit("TELEGRAM_UPDATE_REPLAY_MISMATCH", { updateId: item.updateId }, correlationId);
        return outcome("BLOCKED", "TELEGRAM_UPDATE_ID_PAYLOAD_MISMATCH");
      }
      if (claim.status !== "CLAIMED") return outcome("ERROR", "TELEGRAM_UPDATE_DURABLE_CLAIM_FAILED");
      leaseToken = claim.leaseToken;
    } else {
      const prior = updates.get(item.updateId);
      if (prior) {
        if (prior.payloadDigest !== item.payloadDigest) {
          emit("TELEGRAM_UPDATE_REPLAY_MISMATCH", { updateId: item.updateId }, correlationId);
          return outcome("BLOCKED", "TELEGRAM_UPDATE_ID_PAYLOAD_MISMATCH");
        }
        return prior.result === null
          ? outcome("PENDING", "TELEGRAM_UPDATE_PROCESSING", { updateId: item.updateId })
          : outcome("DUPLICATE", "TELEGRAM_UPDATE_ALREADY_PROCESSED", { updateId: item.updateId, original: prior.result });
      }
      updates.set(item.updateId, { payloadDigest: item.payloadDigest, result: null });
    }
    if (item.updateKind === "widget_query" || item.updateKind === "shared_widget_query") {
      let widgetResult;
      if (typeof handleWidgetQuery !== "function") {
        widgetResult = outcome("DENY", "TELEGRAM_WIDGET_QUERY_CONTEXT_UNSUPPORTED");
      } else {
        try { widgetResult = await handleWidgetQuery({ envelope: item, update });
        catch { widgetResult = outcome("ERROR", "TELEGRAM_WIDGET_QUERY_HANDLER_FAILED"); }
      }
      if (widgetResult?.status === "ERROR") {
        if (store) store.releaseUpdate({ updateId: item.updateId, leaseToken });
        else updates.delete(item.updateId);
        return widgetResult;
      }
      const widgetAudit = buildAuditEvent("TELEGRAM_WIDGET_QUERY_HANDLED", {
        updateId: item.updateId,
        widgetQueryId: item.widgetQueryId,
        status: widgetResult?.status ?? "ERROR",
      }, correlationId);
      if (store && store.completeUpdate({ updateId: item.updateId, payloadDigest: item.payloadDigest, leaseToken, result: widgetResult, auditEvent: widgetAudit }) !== true) {
        store.releaseUpdate({ updateId: item.updateId, leaseToken });
        return outcome("ERROR", "TELEGRAM_WIDGET_QUERY_PERSISTENCE_FAILED");
      }
      if (store) journal.push(widgetAudit);
      else {
        updates.get(item.updateId).result = widgetResult;
        emit("TELEGRAM_WIDGET_QUERY_HANDLED", { updateId: item.updateId, widgetQueryId: item.widgetQueryId, status: widgetResult?.status ?? "ERROR" }, correlationId);
      }
      return widgetResult;
    }
    if (item.text !== null && ["message", "channel_post", "edited_message", "business_message"].includes(item.updateKind)) {
      const intake = frozen({
        schemaVersion: "kratt-telegram-intake/v1",
        candidateId: randomUUID(),
        updateId: item.updateId,
        correlationId,
        actorTelegramUserId: item.actorTelegramUserId,
        chatId: item.chatId,
        chatType: item.chatType,
        text: item.text,
        contentDigest: digest(item.text),
        capturedAt: record.receivedAt,
        reviewState: "UNREVIEWED",
        networkAccess: false,
      });
      const intakeAudit = buildAuditEvent("TELEGRAM_INTAKE_UNREVIEWED", { candidateId: intake.candidateId, contentDigest: intake.contentDigest }, correlationId);
      let intakePersisted = false;
      try {
        intakePersisted = await saveIntake(intake, { updateId: item.updateId, payloadDigest: item.payloadDigest, leaseToken, auditEvent: store ? intakeAudit : undefined }) === true;
      } catch { intakePersisted = false; }
      if (!intakePersisted) {
        if (store) store.releaseUpdate({ updateId: item.updateId, leaseToken });
        else updates.delete(item.updateId);
        return outcome("ERROR", "TELEGRAM_INTAKE_PERSISTENCE_FAILED");
      }
      intakes.push(intake);
      if (store) journal.push(intakeAudit);
      else emit("TELEGRAM_INTAKE_UNREVIEWED", { candidateId: intake.candidateId, contentDigest: intake.contentDigest }, correlationId);
      const result = outcome("OK", "TELEGRAM_INTAKE_RECORDED_UNREVIEWED", { intake });
      if (!store) updates.get(item.updateId).result = result;
      return result;
    }
    const result = outcome("OK", "TELEGRAM_UPDATE_ROUTED", { envelope: record });
    const routedAudit = buildAuditEvent("TELEGRAM_UPDATE_ROUTED", { updateId: item.updateId, updateKind: item.updateKind }, correlationId);
    if (store && store.completeUpdate({ updateId: item.updateId, payloadDigest: item.payloadDigest, leaseToken, result, auditEvent: routedAudit }) !== true) {
      store.releaseUpdate({ updateId: item.updateId, leaseToken });
      return outcome("ERROR", "TELEGRAM_UPDATE_COMPLETION_PERSISTENCE_FAILED");
    }
    if (store) journal.push(routedAudit);
    else emit("TELEGRAM_UPDATE_ROUTED", { updateId: item.updateId, updateKind: item.updateKind }, correlationId);
    if (!store) updates.get(item.updateId).result = result;
    return result;
  }

  function createClaimReviewRequest({
    projection,
    actorTelegramUserId,
    chatId,
    ttlMs = 5 * 60_000,
    policyVersion = "strict/v1",
    chatType = "private",
  } = {}) {
    if (!architects.has(String(actorTelegramUserId)) || !/^[0-9]{1,24}$/.test(String(chatId)) || chatType !== "private" ||
        !projection || typeof projection.claimId !== "string" ||
        typeof projection.claimDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(projection.claimDigest) ||
        typeof projection.evidenceSnapshotDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(projection.evidenceSnapshotDigest) ||
        typeof projection.rootDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(projection.rootDigest) ||
        typeof policyVersion !== "string" || !policyVersion.trim() ||
        !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60_000) {
      return outcome("DENY", "TELEGRAM_REVIEW_REQUEST_INVALID_OR_UNAUTHORIZED");
    }
    const createdAt = timestamp();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const request = frozen({
      schemaVersion: "kratt-telegram-approval-request/v1",
      requestId: randomUUID(),
      nonce: randomUUID(),
      actorTelegramUserId: String(actorTelegramUserId),
      chatId: String(chatId),
      chatType: "private",
      claimId: projection.claimId,
      targetDigest: projection.claimDigest,
      evidenceSnapshotDigest: projection.evidenceSnapshotDigest,
      rootDigest: projection.rootDigest,
      policyVersion,
      allowedDecisions: DECISIONS,
      createdAt,
      expiresAt,
      state: "PENDING",
    });
    const requestAudit = buildAuditEvent("TELEGRAM_REVIEW_REQUEST_CREATED", { requestId: request.requestId, claimId: request.claimId, targetDigest: request.targetDigest }, request.requestId);
    if (store && store.saveReviewRequest(request, requestAudit) !== true) return outcome("ERROR", "TELEGRAM_REVIEW_REQUEST_PERSISTENCE_FAILED");
    requests.set(request.requestId, { request, consumed: false });
    if (store) journal.push(requestAudit);
    else emit("TELEGRAM_REVIEW_REQUEST_CREATED", { requestId: request.requestId, claimId: request.claimId, targetDigest: request.targetDigest }, request.requestId);
    return outcome("PENDING", "STRICT_ARCHITECT_DECISION_REQUIRED", { request });
  }

  async function resolveClaimReview({
    requestId,
    actorTelegramUserId,
    chatId,
    chatType = "private",
    decision,
    reason = "",
    targetDigest,
    evidenceSnapshotDigest,
    rootDigest,
    policyVersion,
    proof,
  } = {}) {
    let entry = requests.get(requestId);
    if (!entry && store) {
      const stored = store.getReviewRequest(requestId);
      if (stored) {
        entry = { request: stored.request, consumed: stored.state === "CONSUMED" || stored.state === "CANCELLED" || stored.state === "EXPIRED", processing: stored.state === "PROCESSING" };
        requests.set(requestId, entry);
        if (stored.state === "CONSUMED") {
          const priorDecision = store.getDecision(requestId);
          if (priorDecision) decisions.set(requestId, priorDecision);
        }
      }
    }
    if (!entry) return outcome("NOT_FOUND", "TELEGRAM_APPROVAL_REQUEST_NOT_FOUND");
    const { request } = entry;
    if (entry.consumed) return decisions.has(requestId)
      ? outcome("DUPLICATE", "TELEGRAM_DECISION_ALREADY_PERSISTED", { decision: decisions.get(requestId) })
      : outcome("BLOCKED", "TELEGRAM_APPROVAL_REQUEST_CONSUMED");
    if (entry.processing) return outcome("BLOCKED", "TELEGRAM_APPROVAL_ALREADY_IN_PROGRESS");
    if (!architects.has(String(actorTelegramUserId)) ||
        String(actorTelegramUserId) !== request.actorTelegramUserId ||
        String(chatId) !== request.chatId || chatType !== "private") {
      return outcome("DENY", "TELEGRAM_APPROVAL_ACTOR_OR_CHAT_MISMATCH");
    }
    if (!DECISIONS.includes(decision)) return outcome("DENY", "TELEGRAM_DECISION_INVALID");
    if ((decision === "REJECT" || decision === "CONTEST") && (typeof reason !== "string" || !reason.trim())) {
      return outcome("DENY", "TELEGRAM_DECISION_REASON_REQUIRED");
    }

    let currentTime;
    try { currentTime = Date.parse(timestamp()); } catch { currentTime = NaN; }
    if (!Number.isFinite(currentTime) || currentTime >= Date.parse(request.expiresAt)) {
      const expiryAudit = buildAuditEvent("TELEGRAM_APPROVAL_EXPIRED", { requestId }, requestId);
      if (store) {
        store.expireReviewRequest(requestId, expiryAudit);
        journal.push(expiryAudit);
      } else emit("TELEGRAM_APPROVAL_EXPIRED", { requestId }, requestId);
      entry.consumed = true;
      return outcome("DENY", "TELEGRAM_APPROVAL_REQUEST_EXPIRED");
    }

    if (store && store.claimReviewRequest(requestId) !== true) {
      const stored = store.getReviewRequest(requestId);
      return outcome("BLOCKED", stored?.state === "CONSUMED" ? "TELEGRAM_APPROVAL_REQUEST_CONSUMED" : "TELEGRAM_APPROVAL_ALREADY_IN_PROGRESS");
    }
    const binding = frozen({
      requestId: request.requestId,
      nonce: request.nonce,
      actorTelegramUserId: request.actorTelegramUserId,
      chatId: request.chatId,
      claimId: request.claimId,
      targetDigest: request.targetDigest,
      evidenceSnapshotDigest: request.evidenceSnapshotDigest,
      rootDigest: request.rootDigest,
      policyVersion: request.policyVersion,
      decision,
      reason: typeof reason === "string" ? reason.trim() : "",
      expiresAt: request.expiresAt,
    });
    if (targetDigest !== request.targetDigest ||
        evidenceSnapshotDigest !== request.evidenceSnapshotDigest ||
        rootDigest !== request.rootDigest ||
        policyVersion !== request.policyVersion) {
      if (store) store.releaseReviewRequest(requestId);
      return outcome("BLOCKED", "TELEGRAM_APPROVAL_BINDING_MISMATCH");
    }
    if (typeof verifyApproval !== "function") {
      if (store) store.releaseReviewRequest(requestId);
      return outcome("DENY", "TELEGRAM_TRUSTED_APPROVAL_VERIFIER_UNAVAILABLE");
    }
    entry.processing = true;
    let verified = false;
    try { verified = await verifyApproval(proof, binding) === true; } catch { verified = false; }
    if (!verified) {
      entry.processing = false;
      if (store) store.releaseReviewRequest(requestId);
      return outcome("DENY", "TELEGRAM_APPROVAL_PROOF_INVALID");
    }

    const decisionRecord = frozen({
      schemaVersion: "kratt-telegram-validation-decision/v1",
      decisionId: randomUUID(),
      requestId,
      actorTelegramUserId: request.actorTelegramUserId,
      decision,
      reason: binding.reason,
      claimId: request.claimId,
      targetDigest: request.targetDigest,
      evidenceSnapshotDigest: request.evidenceSnapshotDigest,
      rootDigest: request.rootDigest,
      policyVersion: request.policyVersion,
      verifiedAt: timestamp(),
    });
    const decisionAudit = buildAuditEvent("TELEGRAM_DECISION_PERSISTED", { decisionId: decisionRecord.decisionId, requestId, decision }, requestId);
    const durableBinding = frozen({ ...binding, approvalProof: proof });
    let persisted = false;
    try { persisted = await saveDecision(decisionRecord, durableBinding, store ? decisionAudit : undefined) === true; } catch { persisted = false; }
    if (!persisted) {
      entry.processing = false;
      if (store) store.releaseReviewRequest(requestId);
      return outcome("ERROR", "TELEGRAM_DECISION_PERSISTENCE_FAILED");
    }
    entry.processing = false;
    entry.consumed = true;
    decisions.set(requestId, decisionRecord);
    if (store) journal.push(decisionAudit);
    else emit("TELEGRAM_DECISION_PERSISTED", { decisionId: decisionRecord.decisionId, requestId, decision }, requestId);
    return outcome("OK", "TELEGRAM_DECISION_PERSISTED", { decision: decisionRecord });
  }

  function cancelClaimReview({ requestId, actorTelegramUserId } = {}) {
    let entry = requests.get(requestId);
    if (!entry && store) {
      const stored = store.getReviewRequest(requestId);
      if (stored) {
        entry = { request: stored.request, consumed: stored.state === "CONSUMED" || stored.state === "CANCELLED" || stored.state === "EXPIRED", processing: stored.state === "PROCESSING" };
        requests.set(requestId, entry);
      }
    }
    if (!entry) return outcome("NOT_FOUND", "TELEGRAM_APPROVAL_REQUEST_NOT_FOUND");
    if (String(actorTelegramUserId) !== entry.request.actorTelegramUserId ||
        !architects.has(String(actorTelegramUserId))) return outcome("DENY", "TELEGRAM_CANCELLATION_ACTOR_MISMATCH");
    if (entry.consumed) return outcome("BLOCKED", "TELEGRAM_APPROVAL_REQUEST_TERMINAL");
    if (entry.processing) return outcome("BLOCKED", "TELEGRAM_APPROVAL_ALREADY_IN_PROGRESS");
    const cancellationAudit = buildAuditEvent("TELEGRAM_APPROVAL_CANCELLED", { requestId }, requestId);
    if (store && store.cancelReviewRequest(requestId, cancellationAudit) !== true) return outcome("BLOCKED", "TELEGRAM_APPROVAL_REQUEST_TERMINAL");
    entry.consumed = true;
    if (store) journal.push(cancellationAudit);
    else emit("TELEGRAM_APPROVAL_CANCELLED", { requestId }, requestId);
    return outcome("OK", "TELEGRAM_APPROVAL_CANCELLED", { requestId });
  }

  function snapshot() {
    if (store) return frozen(store.snapshot());
    return frozen({
      intakeCount: intakes.length,
      pendingReviews: [...requests.values()].filter(entry => !entry.consumed).map(entry => entry.request),
      decisions: [...decisions.values()],
      journal: [...journal],
      journalHead: journal.at(-1)?.hash ?? null,
    });
  }

  return Object.freeze({
    ingestAuthenticatedUpdate,
    createClaimReviewRequest,
    resolveClaimReview,
    cancelClaimReview,
    snapshot,
  });
}
