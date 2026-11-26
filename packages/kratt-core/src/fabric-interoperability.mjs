import { createHash, verify as cryptoVerify } from "node:crypto";
import { types as utilTypes } from "node:util";

export const FABRIC_WIRE_PROTOCOL = "3XT-FABRIC/1";
export const FABRIC_CANONICAL_SCHEMA = "3xt-fabric-canonical-event/v2";
export const MAX_FABRIC_EVENT_BYTES = 256 * 1024;
export const MAX_FABRIC_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_FABRIC_FUTURE_SKEW_MS = 5 * 60 * 1000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[a-z][a-z0-9._:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const EVENT_KEYS = Object.freeze([
  "protocol", "event_id", "event_type", "source_node", "destination_node", "source_revision",
  "correlation_id", "parent_event_id", "sequence", "issued_at", "expires_at", "scope",
  "payload_reference", "evidence_references", "key_id", "payload", "content_digest", "signature"
]);
const DIGEST_EXCLUDED = new Set(["content_digest", "signature"]);

const fail = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });
const ok = value => ({ ok: true, value });
const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value) && !utilTypes.isProxy(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = value => typeof value === "string" && ID.test(value);
const validToken = value => typeof value === "string" && TOKEN.test(value);

function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function strictUtcMillis(value) {
  if (typeof value !== "string") return null;
  const match = UTC.exec(value);
  if (!match) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  try {
    return new Date(millis).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z` ? millis : null;
  } catch {
    return null;
  }
}

/** Copy only own, enumerable data properties. Never invokes getters or accepts proxies. */
function snapshotJson(value, budget = { nodes: 0 }, depth = 0, seen = new WeakSet()) {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 32) throw new TypeError("SNAPSHOT_LIMIT_EXCEEDED");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!validUnicode(value)) throw new TypeError("INVALID_UNICODE");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("NON_FINITE_NUMBER");
    return value;
  }
  if (typeof value !== "object" || value === undefined || utilTypes.isProxy(value)) throw new TypeError("NON_JSON_VALUE");
  if (seen.has(value)) throw new TypeError("CYCLIC_VALUE");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key === "symbol")) throw new TypeError("SYMBOL_KEY");
      if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
        throw new TypeError("ARRAY_PROPERTIES_INVALID");
      }
      const copy = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("ARRAY_HOLE_OR_ACCESSOR");
        copy.push(snapshotJson(descriptor.value, budget, depth + 1, seen));
      }
      return copy;
    }
    if (!isRecord(value)) throw new TypeError("NON_PLAIN_OBJECT");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 256) throw new TypeError("OBJECT_KEY_LIMIT_EXCEEDED");
    const copy = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("SYMBOL_KEY");
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("UNSAFE_OBJECT_KEY");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("ACCESSOR_OR_NON_ENUMERABLE_PROPERTY");
      copy[key] = snapshotJson(descriptor.value, budget, depth + 1, seen);
    }
    return copy;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** RFC 8785-compatible serialization for the JSON/I-JSON subset accepted here. */
export function canonicalizeFabricJcs(value) {
  const snapshot = snapshotJson(value);
  const encode = input => {
    if (input === null || typeof input === "boolean" || typeof input === "string") return JSON.stringify(input);
    if (typeof input === "number") return JSON.stringify(Object.is(input, -0) ? 0 : input);
    if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
    const keys = Object.keys(input).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${encode(input[key])}`).join(",")}}`;
  };
  return encode(snapshot);
}

export function fabricEventContentDigest(event) {
  const body = Object.create(null);
  for (const key of EVENT_KEYS) {
    if (!DIGEST_EXCLUDED.has(key)) body[key] = event[key];
  }
  return createHash("sha256").update(canonicalizeFabricJcs(body), "utf8").digest("hex");
}

export function fabricSigningInput(event) {
  return `${FABRIC_WIRE_PROTOCOL}\n${event.source_node}\n${event.key_id}\n${event.content_digest}`;
}

function validateSnapshot(event) {
  const errors = [];
  const keys = Object.keys(event);
  if (keys.length !== EVENT_KEYS.length || keys.some(key => !EVENT_KEYS.includes(key))) return fail("EVENT_SHAPE_INVALID");
  if (event.protocol !== FABRIC_WIRE_PROTOCOL) return fail("SCHEMA_UNSUPPORTED");
  if (!validId(event.event_id)) errors.push("EVENT_ID_INVALID");
  if (!validToken(event.event_type)) errors.push("EVENT_TYPE_INVALID");
  if (!validId(event.source_node) || !validId(event.destination_node) || typeof event.source_revision !== "string" || !SHA1.test(event.source_revision)) errors.push("SOURCE_PROVENANCE_INVALID");
  if (!validId(event.correlation_id) || (event.parent_event_id !== null && !validId(event.parent_event_id))) errors.push("CAUSAL_ID_INVALID");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) errors.push("SEQUENCE_INVALID");
  const issued = strictUtcMillis(event.issued_at);
  const expires = strictUtcMillis(event.expires_at);
  if (issued === null || expires === null) errors.push("TIMESTAMP_INVALID");
  else if (expires <= issued || expires - issued > MAX_FABRIC_EVENT_TTL_MS) errors.push("EVENT_TTL_INVALID");
  if (!Array.isArray(event.scope) || event.scope.length < 1 || event.scope.length > 64 ||
      event.scope.some(item => !validToken(item)) || new Set(event.scope).size !== event.scope.length) errors.push("SCOPE_INVALID");
  if (event.payload_reference !== null && (typeof event.payload_reference !== "string" || event.payload_reference.length < 1 || event.payload_reference.length > 512)) errors.push("PAYLOAD_REFERENCE_INVALID");
  if (!Array.isArray(event.evidence_references) || event.evidence_references.length > 64 ||
      event.evidence_references.some(item => typeof item !== "string" || item.length < 1 || item.length > 512)) errors.push("EVIDENCE_REFERENCES_INVALID");
  if (!validId(event.key_id)) errors.push("KEY_ID_INVALID");
  if (!isRecord(event.payload)) errors.push("PAYLOAD_INVALID");
  if (typeof event.content_digest !== "string" || !SHA256.test(event.content_digest)) errors.push("DIGEST_INVALID");
  if (typeof event.signature !== "string" || event.signature.length < 1 || event.signature.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.signature)) errors.push("SIGNATURE_INVALID");
  return errors.length ? fail("EVENT_SCHEMA_INVALID", errors.join(",")) : ok(event);
}

/** Validate and return an immutable snapshot; nested getters/accessors are never invoked. */
export function validateSteelFabricEventV1(input) {
  let event;
  try {
    event = snapshotJson(input);
  } catch (error) {
    return fail("EVENT_SNAPSHOT_INVALID", error instanceof Error ? error.message : "snapshot failed");
  }
  const validated = validateSnapshot(event);
  if (!validated.ok) return validated;
  try {
    const computed = fabricEventContentDigest(event);
    if (computed !== event.content_digest) return fail("DIGEST_MISMATCH");
  } catch {
    return fail("DIGEST_INVALID");
  }
  return ok(deepFreeze(event));
}

export function parseSteelFabricEventV1(raw) {
  let bytes;
  if (typeof raw === "string") bytes = Buffer.from(raw, "utf8");
  else if (raw instanceof Uint8Array) bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else return fail("INPUT_TYPE_INVALID");
  if (bytes.byteLength > MAX_FABRIC_EVENT_BYTES) return fail("EVENT_TOO_LARGE");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("EVENT_PARSE_FAILED");
  }
  return validateSteelFabricEventV1(parsed);
}

export async function authenticateSteelFabricEventV1(input, { resolveTrustedKey, now = () => Date.now() } = {}) {
  if (typeof resolveTrustedKey !== "function") return fail("TRUSTED_KEY_RESOLVER_REQUIRED");
  const checked = validateSteelFabricEventV1(input);
  if (!checked.ok) return checked;
  const event = checked.value;
  let key;
  try { key = await resolveTrustedKey(event.source_node, event.key_id); } catch { key = null; }
  if (!isRecord(key) || key.source_node !== event.source_node || key.key_id !== event.key_id) return fail("KEY_UNAVAILABLE");
  if (["REVOKED", "COMPROMISED", "DISABLED"].includes(key.status)) return fail("KEY_REVOKED");
  if (!["ACTIVE", "VERIFY_ONLY"].includes(key.status)) return fail("KEY_STATUS_INVALID");
  const issued = strictUtcMillis(event.issued_at);
  const clock = Number(now());
  if (!Number.isFinite(clock)) return fail("CLOCK_UNAVAILABLE");
  const validFrom = key.valid_from === undefined ? null : strictUtcMillis(key.valid_from);
  if (key.valid_from !== undefined && validFrom === null) return fail("KEY_VALIDITY_INVALID");
  if (validFrom !== null && issued < validFrom) return fail("KEY_NOT_YET_VALID");
  if (key.status === "ACTIVE") {
    const signUntil = key.sign_until === undefined ? null : strictUtcMillis(key.sign_until);
    if (key.sign_until !== undefined && signUntil === null) return fail("KEY_VALIDITY_INVALID");
    if (signUntil !== null && issued > signUntil) return fail("KEY_SIGNING_WINDOW_CLOSED");
  } else {
    const retiredAt = strictUtcMillis(key.retired_at);
    if (retiredAt === null || issued > retiredAt) return fail("KEY_RETIRED_FOR_EVENT");
    const verifyUntil = key.verify_until === undefined ? null : strictUtcMillis(key.verify_until);
    if (key.verify_until !== undefined && verifyUntil === null) return fail("KEY_VALIDITY_INVALID");
    if (verifyUntil !== null && clock > verifyUntil) return fail("KEY_VERIFICATION_WINDOW_CLOSED");
  }
  let signature;
  try { signature = Buffer.from(event.signature, "base64"); } catch { return fail("SIGNATURE_INVALID"); }
  if (signature.length !== 64 || signature.toString("base64") !== event.signature) return fail("SIGNATURE_INVALID");
  try {
    const verified = cryptoVerify(null, Buffer.from(fabricSigningInput(event), "utf8"), key.public_key, signature);
    return verified ? ok(Object.freeze({ source_node: key.source_node, key_id: key.key_id, status: key.status })) : fail("SIGNATURE_INVALID");
  } catch {
    return fail("SIGNATURE_INVALID");
  }
}

/** Canonical model preserves wire semantics; absent STEEL agent/component fields remain null. */
export function toCanonicalFabricEventV2(event, authenticatedKey) {
  if (!authenticatedKey || authenticatedKey.source_node !== event.source_node || authenticatedKey.key_id !== event.key_id) {
    return fail("AUTHENTICATED_IDENTITY_REQUIRED");
  }
  const canonical = {
    schema_version: FABRIC_CANONICAL_SCHEMA,
    identity: { event_id: event.event_id, event_type: event.event_type },
    provenance: {
      source_node: event.source_node,
      source_revision: event.source_revision,
      signing_key_id: event.key_id,
      source_agent_id: null,
      source_component: null,
      destination_node: event.destination_node,
      issued_at: event.issued_at,
      expires_at: event.expires_at
    },
    causality: { correlation_id: event.correlation_id, parent_event_id: event.parent_event_id },
    ordering: { source_sequence: event.sequence },
    authorization_request: { requested_scope: [...event.scope] },
    references: { payload_reference: event.payload_reference, evidence_references: [...event.evidence_references] },
    payload: event.payload,
    integrity: { algorithm: "SHA-256+Ed25519", content_digest: event.content_digest, key_id: event.key_id, signature: event.signature }
  };
  try { return ok(deepFreeze(snapshotJson(canonical))); }
  catch { return fail("CANONICAL_MAPPING_FAILED"); }
}

function validPolicyList(value) {
  return Array.isArray(value) && value.length <= 256 && value.every(validToken) && new Set(value).size === value.length;
}

/** Server-owned policy must explicitly bind node, destination, event type and every requested scope. */
export function authorizeSteelFabricEventV1(event, authenticatedKey, policy) {
  if (!authenticatedKey || authenticatedKey.source_node !== event.source_node || authenticatedKey.key_id !== event.key_id) return fail("AUTHENTICATED_IDENTITY_REQUIRED");
  let trustedPolicy;
  try { trustedPolicy = snapshotJson(policy); } catch { return fail("SOURCE_NOT_AUTHORIZED"); }
  if (!isRecord(trustedPolicy) || trustedPolicy.source_node !== event.source_node || trustedPolicy.status !== "ACTIVE") return fail("SOURCE_NOT_AUTHORIZED");
  if (!Array.isArray(trustedPolicy.destinations) || !trustedPolicy.destinations.includes(event.destination_node)) return fail("DESTINATION_NOT_AUTHORIZED");
  if (!validPolicyList(trustedPolicy.allowed_event_types) || !trustedPolicy.allowed_event_types.includes(event.event_type)) return fail("EVENT_TYPE_NOT_AUTHORIZED");
  if (!validPolicyList(trustedPolicy.allowed_scope) || !event.scope.every(scope => trustedPolicy.allowed_scope.includes(scope))) return fail("SCOPE_NOT_AUTHORIZED");
  if (trustedPolicy.key_id !== undefined && trustedPolicy.key_id !== authenticatedKey.key_id) return fail("KEY_POLICY_MISMATCH");
  return ok(Object.freeze({
    source_node: event.source_node,
    destination_node: event.destination_node,
    effective_scope: Object.freeze([...event.scope]),
    policy_revision: typeof trustedPolicy.revision === "string" ? trustedPolicy.revision : null
  }));
}

/**
 * Durable inbound boundary. The sequence watermark and inbox insert are serialized per source.
 * Gaps are accepted but explicitly surfaced; stale or duplicate sequence numbers are rejected.
 * The handler must use the supplied transaction client for any durable local effects.
 */
export async function receiveSteelFabricEventV1(pool, raw, deps = {}) {
  if (!pool || typeof pool.connect !== "function") return fail("PERSISTENCE_UNAVAILABLE");
  if (typeof deps.resolveTrustedKey !== "function" || typeof deps.resolveNodePolicy !== "function" || typeof deps.handler !== "function") {
    return fail("INGRESS_DEPENDENCIES_REQUIRED");
  }
  if (!validId(deps.localNodeId)) return fail("LOCAL_NODE_ID_REQUIRED");
  const parsed = parseSteelFabricEventV1(raw);
  if (!parsed.ok) return parsed;
  const event = parsed.value;
  if (event.destination_node !== deps.localNodeId) return fail("DESTINATION_NOT_LOCAL");
  const now = Number((deps.now ?? Date.now)());
  if (!Number.isFinite(now)) return fail("CLOCK_UNAVAILABLE");
  const issuedAt = strictUtcMillis(event.issued_at);
  const expiresAt = strictUtcMillis(event.expires_at);
  if (issuedAt > now + MAX_FABRIC_FUTURE_SKEW_MS) return fail("EVENT_NOT_YET_VALID");
  if (expiresAt <= now) return fail("EVENT_EXPIRED");

  const authenticated = await authenticateSteelFabricEventV1(event, { resolveTrustedKey: deps.resolveTrustedKey, now: () => now });
  if (!authenticated.ok) return authenticated;
  let policy;
  try { policy = await deps.resolveNodePolicy(event.source_node, authenticated.value); } catch { policy = null; }
  const authorized = authorizeSteelFabricEventV1(event, authenticated.value, policy);
  if (!authorized.ok) return authorized;

  let client;
  try { client = await pool.connect(); } catch { return fail("PERSISTENCE_UNAVAILABLE"); }
  let handlerStarted = false;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const existing = await client.query(
      `SELECT event_id, source_node, source_sequence, content_digest
         FROM kratt_fabric_event_inbox
        WHERE event_id = $1 OR (source_node = $2 AND source_sequence = $3)
        FOR UPDATE`,
      [event.event_id, event.source_node, event.sequence]
    );
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      await client.query("ROLLBACK");
      transactionOpen = false;
      if (row.event_id === event.event_id && row.source_node === event.source_node &&
          Number(row.source_sequence) === event.sequence && row.content_digest === event.content_digest) {
        return ok({ duplicate: true, sequence_gap: false });
      }
      return fail("EVENT_REPLAY_OR_CONFLICT");
    }

    await client.query(
      `INSERT INTO kratt_fabric_source_heads (source_node, last_sequence, last_event_id)
       VALUES ($1, 0, NULL) ON CONFLICT (source_node) DO NOTHING`,
      [event.source_node]
    );
    const headResult = await client.query(
      `SELECT last_sequence, last_event_id FROM kratt_fabric_source_heads
        WHERE source_node = $1 FOR UPDATE`,
      [event.source_node]
    );
    if (headResult.rowCount !== 1) throw new Error("FABRIC_SOURCE_HEAD_UNAVAILABLE");

    // Re-check after taking the source watermark lock: a concurrent identical delivery
    // may have committed after the optimistic inbox lookup above.
    const racedDuplicate = await client.query(
      `SELECT event_id, source_node, source_sequence, content_digest
         FROM kratt_fabric_event_inbox
        WHERE event_id = $1 OR (source_node = $2 AND source_sequence = $3)
        FOR UPDATE`,
      [event.event_id, event.source_node, event.sequence]
    );
    if (racedDuplicate.rowCount > 0) {
      const row = racedDuplicate.rows[0];
      await client.query("ROLLBACK");
      transactionOpen = false;
      if (row.event_id === event.event_id && row.source_node === event.source_node &&
          Number(row.source_sequence) === event.sequence && row.content_digest === event.content_digest) {
        return ok({ duplicate: true, sequence_gap: false });
      }
      return fail("EVENT_REPLAY_OR_CONFLICT");
    }
    const lastSequence = Number(headResult.rows[0].last_sequence);
    if (event.sequence <= lastSequence) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return fail("SEQUENCE_STALE");
    }
    const sequenceGap = event.sequence > lastSequence + 1;
    if (event.parent_event_id !== null) {
      const parent = await client.query("SELECT event_id FROM kratt_fabric_event_inbox WHERE event_id = $1", [event.parent_event_id]);
      if (parent.rowCount !== 1) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return fail("CAUSAL_PARENT_MISSING");
      }
    }

    await client.query(
      `INSERT INTO kratt_fabric_event_inbox
        (event_id, source_node, destination_node, source_sequence, parent_event_id,
         content_digest, issued_at, expires_at, event_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [event.event_id, event.source_node, event.destination_node, event.sequence, event.parent_event_id,
       event.content_digest, event.issued_at, event.expires_at, JSON.stringify(event)]
    );
    await client.query(
      `UPDATE kratt_fabric_source_heads
          SET last_sequence = $2, last_event_id = $3, updated_at = clock_timestamp()
        WHERE source_node = $1`,
      [event.source_node, event.sequence, event.event_id]
    );
    const canonical = toCanonicalFabricEventV2(event, authenticated.value);
    if (!canonical.ok) throw new Error(canonical.code);
    handlerStarted = true;
    const handled = await deps.handler(canonical.value, { client, authorization: authorized.value, sequence_gap: sequenceGap });
    await client.query("COMMIT");
    transactionOpen = false;
    return ok({ duplicate: false, sequence_gap: sequenceGap, result: handled });
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    return handlerStarted ? fail("EVENT_HANDLER_FAILED") : fail("PERSISTENCE_UNAVAILABLE", error instanceof Error ? error.message : "database operation failed");
  } finally {
    client.release();
  }
}

export const FABRIC_EVENT_ERROR_CODES = Object.freeze([
  "EVENT_SHAPE_INVALID", "EVENT_SNAPSHOT_INVALID", "SCHEMA_UNSUPPORTED", "EVENT_ID_INVALID", "EVENT_TYPE_INVALID",
  "SOURCE_PROVENANCE_INVALID", "CAUSAL_ID_INVALID", "SEQUENCE_INVALID", "TIMESTAMP_INVALID", "EVENT_TTL_INVALID",
  "SCOPE_INVALID", "PAYLOAD_REFERENCE_INVALID", "EVIDENCE_REFERENCES_INVALID", "KEY_ID_INVALID", "PAYLOAD_INVALID",
  "DIGEST_INVALID", "SIGNATURE_INVALID", "DIGEST_MISMATCH", "EVENT_TOO_LARGE", "INPUT_TYPE_INVALID", "EVENT_PARSE_FAILED",
  "TRUSTED_KEY_RESOLVER_REQUIRED", "KEY_UNAVAILABLE", "KEY_REVOKED", "KEY_STATUS_INVALID", "CLOCK_UNAVAILABLE",
  "KEY_VALIDITY_INVALID", "KEY_NOT_YET_VALID", "KEY_SIGNING_WINDOW_CLOSED", "KEY_RETIRED_FOR_EVENT", "KEY_VERIFICATION_WINDOW_CLOSED",
  "AUTHENTICATED_IDENTITY_REQUIRED", "CANONICAL_MAPPING_FAILED", "SOURCE_NOT_AUTHORIZED",
  "DESTINATION_NOT_AUTHORIZED", "EVENT_TYPE_NOT_AUTHORIZED", "SCOPE_NOT_AUTHORIZED", "KEY_POLICY_MISMATCH",
  "PERSISTENCE_UNAVAILABLE", "INGRESS_DEPENDENCIES_REQUIRED", "LOCAL_NODE_ID_REQUIRED", "DESTINATION_NOT_LOCAL",
  "EVENT_NOT_YET_VALID", "EVENT_EXPIRED", "EVENT_REPLAY_OR_CONFLICT", "SEQUENCE_STALE", "CAUSAL_PARENT_MISSING", "EVENT_HANDLER_FAILED"
]);
