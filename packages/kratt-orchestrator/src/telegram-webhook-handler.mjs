import { verifyTelegramWebhookSecret } from "./telegram-control-plane.mjs";

function respond(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.end(JSON.stringify(body));
}

async function readBoundedJson(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("TELEGRAM_WEBHOOK_BODY_TOO_LARGE");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new Error("TELEGRAM_WEBHOOK_BODY_EMPTY");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * HTTP ingress handler for Telegram webhook updates.
 * Mount behind a TLS-terminating edge. This function does not create a server,
 * set a webhook, fetch URLs, or call Telegram's outbound API.
 */
export function createTelegramWebhookHandler({
  controlPlane,
  webhookSecret,
  allowRequest,
  maxBodyBytes = 64 * 1024,
} = {}) {
  if (!controlPlane || typeof controlPlane.ingestAuthenticatedUpdate !== "function") {
    throw new TypeError("TELEGRAM_CONTROL_PLANE_REQUIRED");
  }
  if (typeof webhookSecret !== "string" || webhookSecret.length < 1 || webhookSecret.length > 256) {
    throw new TypeError("TELEGRAM_WEBHOOK_SECRET_REQUIRED");
  }
  if (typeof allowRequest !== "function") throw new TypeError("TELEGRAM_INGRESS_RATE_LIMITER_REQUIRED");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1024 * 1024) {
    throw new TypeError("TELEGRAM_WEBHOOK_BODY_LIMIT_INVALID");
  }

  return async function handleTelegramWebhook(request, response) {
    if (request.method !== "POST") return respond(response, 405, { status: "DENY", reason: "POST_REQUIRED" });
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return respond(response, 415, { status: "DENY", reason: "JSON_CONTENT_TYPE_REQUIRED" });
    }
    const receivedSecret = request.headers["x-telegram-bot-api-secret-token"];
    if (!verifyTelegramWebhookSecret(receivedSecret, webhookSecret)) {
      return respond(response, 401, { status: "DENY", reason: "WEBHOOK_AUTHENTICATION_FAILED" });
    }

    let allowed = false;
    try {
      allowed = await allowRequest(Object.freeze({
        remoteAddress: request.socket?.remoteAddress ?? null,
        method: request.method,
      })) === true;
    } catch { allowed = false; }
    if (!allowed) return respond(response, 429, { status: "BLOCKED", reason: "INGRESS_RATE_LIMITED" });

    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined) {
      const declared = Number(contentLength);
      if (!Number.isSafeInteger(declared) || declared < 0) {
        return respond(response, 400, { status: "REJECTED", reason: "CONTENT_LENGTH_INVALID" });
      }
      if (declared > maxBodyBytes) {
        request.resume();
        return respond(response, 413, { status: "REJECTED", reason: "WEBHOOK_BODY_TOO_LARGE" });
      }
    }

    let update;
    try {
      update = await readBoundedJson(request, maxBodyBytes);
    } catch (error) {
      const tooLarge = error?.code === "BODY_TOO_LARGE";
      return respond(response, tooLarge ? 413 : 400, {
        status: "REJECTED",
        reason: tooLarge ? "WEBHOOK_BODY_TOO_LARGE" : "WEBHOOK_JSON_INVALID",
      });
    }

    try {
      const result = await controlPlane.ingestAuthenticatedUpdate({ update, receivedSecret });
      const statusCode = ({
        OK: 200,
        DUPLICATE: 200,
        PENDING: 202,
        DENY: 401,
        REJECTED: 400,
        BLOCKED: 409,
        ERROR: 503,
      })[result?.status] ?? 400;
      return respond(response, statusCode, result);
    } catch {
      return respond(response, 503, { status: "ERROR", reason: "TELEGRAM_INGRESS_UNAVAILABLE" });
    }
  };
}
