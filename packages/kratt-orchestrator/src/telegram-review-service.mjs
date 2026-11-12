import { renderClaimReviewWidget } from "./telegram-review-widget.mjs";

/**
 * Creates and sends a private, non-shared Claim Review Widget.
 * Sending the widget creates only a pending review request; no decision is
 * approved and no signature is fabricated by this service.
 */
export function createTelegramReviewWidgetService({ controlPlane, store, botApiClient, projectionService } = {}) {
  if (!controlPlane || typeof controlPlane.createClaimReviewRequest !== "function" ||
      typeof controlPlane.cancelClaimReview !== "function") {
    throw new TypeError("TELEGRAM_CONTROL_PLANE_REQUIRED");
  }
  if (!store || typeof store.linkReviewMessage !== "function") {
    throw new TypeError("TELEGRAM_REVIEW_MESSAGE_STORE_REQUIRED");
  }
  if (!botApiClient || typeof botApiClient.sendClaimReviewWidget !== "function") {
    throw new TypeError("TELEGRAM_BOT_API_WIDGET_CLIENT_REQUIRED");
  }
  if (projectionService !== undefined && (!projectionService || typeof projectionService.get !== "function")) {
    throw new TypeError("TELEGRAM_CLAIM_PROJECTION_SERVICE_INVALID");
  }

  return Object.freeze({
    async send({ projection, claimId, actorTelegramUserId, chatId, chatType = "private", caption } = {}) {
      if (chatType !== "private" || !/^[0-9]{1,24}$/.test(String(chatId))) {
        return Object.freeze({ status: "DENY", reason: "TELEGRAM_WIDGET_PRIVATE_CHAT_REQUIRED" });
      }
      if (!projection && projectionService && typeof claimId === "string") {
        try { projection = await projectionService.get(claimId); }
        catch { return Object.freeze({ status: "ERROR", reason: "TELEGRAM_CLAIM_PROJECTION_UNAVAILABLE" }); }
      }
      if (!projection) return Object.freeze({ status: "DENY", reason: "TELEGRAM_CLAIM_PROJECTION_REQUIRED" });
      const pending = controlPlane.createClaimReviewRequest({
        projection,
        actorTelegramUserId,
        chatId: String(chatId),
        chatType,
      });
      if (pending.status !== "PENDING") return pending;

      let widget;
      try { widget = renderClaimReviewWidget({ projection, request: pending.request }); }
      catch {
        controlPlane.cancelClaimReview({ requestId: pending.request.requestId, actorTelegramUserId });
        return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_RENDER_FAILED" });
      }

      let message;
      try {
        message = await botApiClient.sendClaimReviewWidget({
          chatId: Number(chatId),
          chatType,
          html: widget.html,
          chatData: widget.chatData,
          caption,
        });
      } catch {
        controlPlane.cancelClaimReview({ requestId: pending.request.requestId, actorTelegramUserId });
        return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_SEND_FAILED" });
      }

      if (!message || !Number.isSafeInteger(message.message_id) || message.message_id < 1 ||
          store.linkReviewMessage(String(chatId), message.message_id, pending.request.requestId) !== true) {
        controlPlane.cancelClaimReview({ requestId: pending.request.requestId, actorTelegramUserId });
        return Object.freeze({ status: "ERROR", reason: "TELEGRAM_WIDGET_MESSAGE_BINDING_FAILED" });
      }

      return Object.freeze({
        status: "OK",
        reason: "TELEGRAM_REVIEW_WIDGET_SENT_PENDING_SIGNATURE",
        requestId: pending.request.requestId,
        chatId: String(chatId),
        messageId: message.message_id,
        widgetBytes: widget.htmlBytes,
        compressedBytes: widget.compressedBytes,
      });
    },
  });
}
