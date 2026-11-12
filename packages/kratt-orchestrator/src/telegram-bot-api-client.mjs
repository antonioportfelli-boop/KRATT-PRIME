import { deflateSync } from "node:zlib";

const API_BASE = "https://api.telegram.org";
const MAX_HTML_BYTES = 32_768;
const MAX_COMPRESSED_BYTES = 4_096;
const MAX_WIDGET_STATE_BYTES = 1_024;
const MAX_RICH_MESSAGE_BYTES = 32_768;

function bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function validateHtml(html) {
  if (typeof html !== "string" || html.length === 0 || html.includes("\u0000")) {
    throw new TypeError("TELEGRAM_WIDGET_HTML_INVALID");
  }
  const size = bytes(html);
  if (size > MAX_HTML_BYTES) throw new RangeError("TELEGRAM_WIDGET_HTML_TOO_LARGE");
  const compressed = deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length;
  if (compressed > MAX_COMPRESSED_BYTES) {
    throw new RangeError("TELEGRAM_WIDGET_HTML_TOO_LARGE");
  }
}

function validateState(value, label) {
  if (typeof value !== "string" || value.includes("\u0000") || bytes(value) > MAX_WIDGET_STATE_BYTES) {
    throw new TypeError(`TELEGRAM_WIDGET_${label}_INVALID`);
  }
}

/**
 * Lazy Bot API client. Creating it does not make a network request.
 * No webhook registration, polling, or deployment is performed automatically.
 */
export function createTelegramBotApiClient({ token, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== "string" || token.length < 10 || token.length > 256 || /[\s/]/.test(token)) {
    throw new TypeError("TELEGRAM_BOT_TOKEN_INVALID");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("TELEGRAM_FETCH_IMPLEMENTATION_REQUIRED");

  async function call(method, parameters) {
    let response;
    try {
      response = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parameters),
      });
    } catch {
      throw new Error(`TELEGRAM_API_TRANSPORT_FAILED:${method}`);
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new Error(`TELEGRAM_API_RESPONSE_INVALID:${method}`);
    }
    if (!response.ok || payload?.ok !== true) {
      const code = Number.isInteger(payload?.error_code) ? payload.error_code : response.status;
      throw new Error(`TELEGRAM_API_REJECTED:${method}:${code}`);
    }
    return payload.result;
  }

  async function sendClaimReviewWidget({ chatId, chatType, html, chatData, caption } = {}) {
    const validPrivateChatId = (typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 0) ||
      (typeof chatId === "string" && /^[0-9]{1,24}$/.test(chatId) && Number(chatId) > 0);
    if (chatType !== "private" || !validPrivateChatId) {
      throw new TypeError("TELEGRAM_WIDGET_PRIVATE_CHAT_REQUIRED");
    }
    validateHtml(html);
    validateState(chatData, "CHAT_DATA");
    const parameters = {
      chat_id: chatId,
      html,
      chat_data: chatData,
      allow_queries: true,
      is_shared: false,
      protect_content: true,
    };
    if (caption !== undefined) {
      if (typeof caption !== "string" || bytes(caption) > 1024) throw new TypeError("TELEGRAM_WIDGET_CAPTION_INVALID");
      parameters.caption = caption;
    }
    return call("sendWidget", parameters);
  }

  async function sendRichMessage({ chatId, markdown, protectContent = true, disableNotification = false } = {}) {
    if (!(typeof chatId === "number" && Number.isSafeInteger(chatId) ||
        typeof chatId === "string" && chatId.length > 0 && chatId.length <= 128) ||
        typeof markdown !== "string" || markdown.length < 1 || bytes(markdown) > MAX_RICH_MESSAGE_BYTES) {
      throw new TypeError("TELEGRAM_RICH_MESSAGE_INVALID");
    }
    return call("sendRichMessage", {
      chat_id: chatId,
      rich_message: { markdown },
      protect_content: protectContent === true,
      disable_notification: disableNotification === true,
    });
  }

  async function answerWidgetQuery(widgetQueryId, data = "") {
    if (typeof widgetQueryId !== "string" || widgetQueryId.length < 1 || widgetQueryId.length > 128 ||
        typeof data !== "string" || bytes(data) > MAX_WIDGET_STATE_BYTES) {
      throw new TypeError("TELEGRAM_WIDGET_QUERY_ANSWER_INVALID");
    }
    return call("answerWidgetQuery", { widget_query_id: widgetQueryId, data });
  }

  async function editMessageWidgetData({ chatId, messageId, chatData } = {}) {
    const validPrivateChatId = (typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 0) ||
      (typeof chatId === "string" && /^[0-9]{1,24}$/.test(chatId) && Number(chatId) > 0);
    if (!validPrivateChatId || !Number.isSafeInteger(messageId) || messageId < 1) {
      throw new TypeError("TELEGRAM_WIDGET_MESSAGE_REFERENCE_INVALID");
    }
    validateState(chatData, "CHAT_DATA");
    return call("editMessageWidgetData", { chat_id: chatId, message_id: messageId, chat_data: chatData });
  }

  return Object.freeze({ sendClaimReviewWidget, sendRichMessage, answerWidgetQuery, editMessageWidgetData });
}
