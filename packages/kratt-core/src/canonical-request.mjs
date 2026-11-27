import { createHash } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 20_000;
const MAX_ARRAY = 4_096;
const MAX_KEYS = 4_096;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export class CanonicalRequestError extends TypeError {
  constructor(code) {
    super(code);
    this.name = "CanonicalRequestError";
    this.code = code;
  }
}

function fail(code) { throw new CanonicalRequestError(code); }

function encode(value, state, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) fail("CANONICAL_NODE_LIMIT_EXCEEDED");
  if (depth > MAX_DEPTH) fail("CANONICAL_DEPTH_LIMIT_EXCEEDED");

  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_NUMBER_NOT_FINITE");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") fail("CANONICAL_TYPE_UNSUPPORTED");

  if (state.active.has(value)) fail("CANONICAL_CYCLE_DETECTED");
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY || Reflect.ownKeys(value).length !== value.length + 1)
        fail("CANONICAL_ARRAY_SHAPE_INVALID");
      const parts = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
          fail("CANONICAL_ARRAY_HOLE_OR_ACCESSOR");
        parts.push(encode(descriptor.value, state, depth + 1));
      }
      return `[${parts.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("CANONICAL_OBJECT_NOT_PLAIN");
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_KEYS || keys.some(key => typeof key !== "string"))
      fail("CANONICAL_OBJECT_KEYS_INVALID");
    keys.sort();
    const parts = [];
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) fail("CANONICAL_UNSAFE_KEY");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        fail("CANONICAL_OBJECT_ACCESSOR_OR_HIDDEN_FIELD");
      parts.push(`${JSON.stringify(key)}:${encode(descriptor.value, state, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    state.active.delete(value);
  }
}

/**
 * Produce a deterministic RFC-8785-inspired JSON representation.
 * Strict data-only subset: no accessors, sparse arrays, exotic prototypes,
 * non-finite values, dangerous property names, or implicit coercion.
 */
export function canonicalizeRequest(value, { maxBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    fail("CANONICAL_BYTE_LIMIT_INVALID");
  const text = encode(value, { active: new WeakSet(), nodes: 0 }, 0);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) fail("CANONICAL_BYTE_LIMIT_EXCEEDED");
  return Object.freeze({ text, byteLength });
}

export function digestCanonicalRequest(value, options) {
  const canonical = canonicalizeRequest(value, options);
  const digest = createHash("sha256").update(canonical.text, "utf8").digest("hex");
  return Object.freeze({
    canonical,
    digest: `sha256:${digest}`,
  });
}

export function createRequestFingerprint({ actor, action, target, provider, policyVersion, payload }, options) {
  if (typeof actor !== "string" || !IDENTIFIER.test(actor) ||
      typeof action !== "string" || !IDENTIFIER.test(action) ||
      typeof provider !== "string" || !IDENTIFIER.test(provider) ||
      typeof policyVersion !== "string" || !IDENTIFIER.test(policyVersion) ||
      !target || typeof target !== "object" || Array.isArray(target)) {
    fail("REQUEST_FINGERPRINT_BINDING_INVALID");
  }
  return digestCanonicalRequest({ actor, action, target, provider, policyVersion, payload }, options);
}

export const CANONICAL_REQUEST_LIMITS = Object.freeze({
  maxBytes: MAX_BYTES,
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxArrayLength: MAX_ARRAY,
  maxObjectKeys: MAX_KEYS,
});
