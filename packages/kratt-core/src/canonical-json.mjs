/**
 * Canonical JSON for trusted digests and deterministic semantic identity.
 *
 * This intentionally accepts only JSON data: finite numbers, strings, booleans,
 * null, dense arrays and plain objects with enumerable data properties. It rejects
 * getters, setters, symbols, sparse arrays, extra array properties, cycles and
 * unsupported JS values instead of silently hashing a lossy JSON.stringify view.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  const active = new Set();

  function encode(input) {
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("CANONICAL_JSON_NON_FINITE_NUMBER");
      return JSON.stringify(Object.is(input, -0) ? 0 : input);
    }
    if (typeof input !== "object") throw new TypeError("CANONICAL_JSON_UNSUPPORTED_VALUE");
    if (active.has(input)) throw new TypeError("CANONICAL_JSON_CYCLE");
    active.add(input);

    try {
      if (Array.isArray(input)) {
        const keys = Reflect.ownKeys(input);
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
            throw new TypeError("CANONICAL_JSON_ARRAY_PROPERTIES_INVALID");
          }
        }
        const parts = [];
        for (let index = 0; index < input.length; index += 1) {
          if (!Object.hasOwn(input, index)) throw new TypeError("CANONICAL_JSON_SPARSE_ARRAY");
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            throw new TypeError("CANONICAL_JSON_ARRAY_ACCESSOR_REJECTED");
          }
          parts.push(encode(descriptor.value));
        }
        return "[" + parts.join(",") + "]";
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("CANONICAL_JSON_OBJECT_PROTOTYPE_INVALID");
      }
      const keys = Reflect.ownKeys(input);
      if (keys.some(key => typeof key !== "string")) {
        throw new TypeError("CANONICAL_JSON_SYMBOL_KEY_REJECTED");
      }
      const parts = [];
      for (const key of keys.sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("CANONICAL_JSON_OBJECT_ACCESSOR_REJECTED");
        }
        parts.push(JSON.stringify(key) + ":" + encode(descriptor.value));
      }
      return "{" + parts.join(",") + "}";
    } finally {
      active.delete(input);
    }
  }

  return encode(value);
}

export function sha256Hex(value) {
  if (typeof value !== "string") throw new TypeError("SHA256_INPUT_STRING_REQUIRED");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalDigest(value, { prefix = "sha256:" } = {}) {
  if (typeof prefix !== "string") throw new TypeError("CANONICAL_DIGEST_PREFIX_INVALID");
  return prefix + sha256Hex(canonicalJson(value));
}
