import { createHash, timingSafeEqual } from "node:crypto";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DIGEST_FIELD = "contentDigest";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeCanonical(value, active = new WeakSet(), path = "$", omitDigestAtRoot = false) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`NON_FINITE_NUMBER:${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError(`UNSUPPORTED_VALUE:${path}`);
  if (active.has(value)) throw new TypeError(`CIRCULAR_VALUE:${path}`);

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some(key => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
        throw new TypeError(`ARRAY_EXTRA_PROPERTY:${path}`);
      }
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`ARRAY_ITEM_INVALID:${path}[${index}]`);
        }
        items.push(encodeCanonical(descriptor.value, active, `${path}[${index}]`));
      }
      if (ownKeys.length !== value.length + 1) throw new TypeError(`ARRAY_HOLE_OR_EXTRA_PROPERTY:${path}`);
      return `[${items.join(",")}]`;
    }

    if (!isPlainObject(value)) throw new TypeError(`NON_PLAIN_OBJECT:${path}`);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string")) throw new TypeError(`SYMBOL_KEY:${path}`);

    const keys = ownKeys.filter(key => !(omitDigestAtRoot && path === "$" && key === DIGEST_FIELD)).sort();
    const fields = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`OBJECT_FIELD_INVALID:${path}.${key}`);
      }
      fields.push(`${JSON.stringify(key)}:${encodeCanonical(descriptor.value, active, `${path}.${key}`)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

/** Return a deterministic JSON representation with recursively sorted object keys. */
export function canonicalizeEvidencePayload(card) {
  if (!isPlainObject(card)) throw new TypeError("EVIDENCE_CARD_MUST_BE_PLAIN_OBJECT");
  return encodeCanonical(card, new WeakSet(), "$", true);
}

/** Compute a SHA-256 digest over all enumerable evidence-card fields except contentDigest. */
export function computeEvidenceCardDigest(card) {
  const canonical = canonicalizeEvidencePayload(card);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hex}`;
}

/** Return a fresh card with a computed contentDigest. Existing digest fields are rejected. */
export function attachEvidenceCardDigest(card) {
  if (!isPlainObject(card)) throw new TypeError("EVIDENCE_CARD_MUST_BE_PLAIN_OBJECT");
  if (Object.hasOwn(card, DIGEST_FIELD)) throw new TypeError("EVIDENCE_CARD_DIGEST_ALREADY_PRESENT");
  canonicalizeEvidencePayload(card);
  const copy = Object.create(Object.getPrototypeOf(card));
  for (const key of Object.keys(card)) {
    const descriptor = Object.getOwnPropertyDescriptor(card, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`OBJECT_FIELD_INVALID:.${key}`);
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(copy, DIGEST_FIELD, {
    value: computeEvidenceCardDigest(copy),
    enumerable: true,
    configurable: true,
    writable: false,
  });
  return copy;
}

/** Verify a card's contentDigest without throwing on untrusted input. */
export function verifyEvidenceCardDigest(card) {
  try {
    if (!isPlainObject(card)) return { ok: false, reason: "EVIDENCE_CARD_SHAPE_INVALID" };
    const descriptor = Object.getOwnPropertyDescriptor(card, DIGEST_FIELD);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !DIGEST_PATTERN.test(descriptor.value)) {
      return { ok: false, reason: "EVIDENCE_CARD_DIGEST_MISSING_OR_INVALID" };
    }
    const expected = Buffer.from(computeEvidenceCardDigest(card), "utf8");
    const actual = Buffer.from(descriptor.value, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, reason: "EVIDENCE_CARD_DIGEST_MISMATCH" };
    }
    return { ok: true, digest: descriptor.value, reason: null };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof TypeError ? error.message.split(":")[0] : "EVIDENCE_CARD_VERIFICATION_FAILED",
    };
  }
}
