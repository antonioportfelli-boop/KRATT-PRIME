import { createHash } from "node:crypto";
import { isIP } from "node:net";

const ACCEPTED_TYPES = ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "text/plain"];

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    try {
      const point = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : match;
    } catch {
      return match;
    }
  });
}

function cleanXmlText(value = "") {
  return decodeEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractElement(block, name) {
  const expression = new RegExp("<(?:[A-Za-z0-9_-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?" + name + "\\s*>", "i");
  return expression.exec(block)?.[1] ?? "";
}

function extractLink(block) {
  const linkTag = /<(?:[A-Za-z0-9_-]+:)?link\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?link\s*>/i.exec(block);
  if (linkTag) return cleanXmlText(linkTag[2]);
  const selfClosing = /<(?:[A-Za-z0-9_-]+:)?link\b([^>]*)\/?\s*>/i.exec(block);
  if (!selfClosing) return "";
  return /\bhref\s*=\s*["']([^"']+)["']/i.exec(selfClosing[1])?.[1] ?? "";
}

function parseDate(value) {
  const text = cleanXmlText(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseFeed(xml, feedUrl, observedAt) {
  const atom = /<feed\b/i.test(xml);
  const itemPattern = atom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const entries = [...xml.matchAll(itemPattern)].slice(0, 100);
  const feedTitle = cleanXmlText(extractElement(xml, "title")) || new URL(feedUrl).hostname;
  const items = [];

  for (const match of entries) {
    const block = match[1];
    const title = cleanXmlText(extractElement(block, "title"));
    const rawLink = extractLink(block);
    const summary = cleanXmlText(
      extractElement(block, "content:encoded") ||
      extractElement(block, "content") ||
      extractElement(block, "summary") ||
      extractElement(block, "description")
    );
    if (!title || !rawLink) continue;

    let itemUrl;
    try {
      itemUrl = new URL(rawLink, feedUrl);
      if (itemUrl.protocol !== "https:" || itemUrl.username || itemUrl.password) continue;
    } catch {
      continue;
    }

    const publishedAt = parseDate(
      extractElement(block, "pubDate") ||
      extractElement(block, "published") ||
      extractElement(block, "updated") ||
      extractElement(block, "date")
    );
    const canonical = {
      sourceUrl: itemUrl.href,
      publisher: feedTitle,
      title,
      content: summary,
      publishedAt,
      observedAt,
      ingestMethod: "rss_atom",
    };
    items.push(Object.freeze({
      ...canonical,
      sourceId: sha256(feedUrl + "\\0" + itemUrl.href + "\\0" + title),
      contentDigest: sha256(title + "\\n" + summary),
      rightsStatus: "unknown",
    }));
  }

  return Object.freeze({
    feedUrl,
    publisher: feedTitle,
    observedAt,
    format: atom ? "atom" : "rss",
    itemCount: items.length,
    items: Object.freeze(items),
  });
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("FEED_RESPONSE_TOO_LARGE");
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("FEED_BODY_UNAVAILABLE");

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("FEED_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function validateFeedUrl(value, allowedHosts) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("FEED_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new TypeError("FEED_URL_NOT_ALLOWED");
  }
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) || !allowedHosts.has(hostname)) throw new TypeError("FEED_HOST_NOT_ALLOWLISTED");
  return url;
}

/**
 * Create a bounded HTTPS-only RSS/Atom reader.
 * The caller must provide an exact hostname allowlist. Redirects are rejected
 * to prevent allowlist bypass. No write capability is exposed.
 */
export function createRssReadAdapter({
  allowedHosts = [],
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  maxBytes = 1_000_000,
  timeoutMs = 8_000,
} = {}) {
  const validHost = host => typeof host === "string" &&
    host === host.trim() && host.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host) &&
    !isIP(host) && host.toLowerCase() !== "localhost" &&
    !host.toLowerCase().endsWith(".localhost") &&
    !host.toLowerCase().endsWith(".local") &&
    !host.toLowerCase().endsWith(".internal");
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || !allowedHosts.every(validHost)) {
    throw new TypeError("RSS_HOST_ALLOWLIST_REQUIRED");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("RSS_FETCH_IMPLEMENTATION_REQUIRED");
  if (typeof now !== "function") throw new TypeError("RSS_TRUSTED_CLOCK_REQUIRED");
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 5_000_000) throw new TypeError("RSS_MAX_BYTES_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) throw new TypeError("RSS_TIMEOUT_INVALID");

  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  return Object.freeze({
    capabilities: Object.freeze(["feed.read", "source.capture"]),
    permissions: Object.freeze({ read: true, write: false }),
    async read({ capability, input } = {}) {
      if (!["feed.read", "source.capture"].includes(capability)) throw new Error("RSS_CAPABILITY_NOT_GRANTED");
      const url = validateFeedUrl(input?.url, hosts);
      const response = await fetchImpl(url.href, {
        method: "GET",
        headers: { Accept: ACCEPTED_TYPES.join(", ") },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) throw new Error("FEED_REDIRECT_REJECTED");
      if (!response.ok) throw new Error("FEED_HTTP_ERROR");
      if (response.redirected) throw new Error("FEED_REDIRECT_REJECTED");
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (contentType && !ACCEPTED_TYPES.includes(contentType)) throw new Error("FEED_CONTENT_TYPE_REJECTED");

      const bytes = await readBounded(response, maxBytes);
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("FEED_XML_DTD_REJECTED");
      if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error("FEED_XML_FORMAT_INVALID");

      const observedAt = now();
      if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
        throw new Error("RSS_TRUSTED_CLOCK_UNAVAILABLE");
      }
      return parseFeed(xml, url.href, observedAt);
    },
  });
}
