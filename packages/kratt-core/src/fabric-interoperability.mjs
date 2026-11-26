import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { incrementFabricMetric } from "./fabric-metrics.mjs";
import { types as utilTypes } from "node:util";

export const FABRIC_WIRE_PROTOCOL = "3XT-FABRIC/1";
export const FABRIC_CANONICAL_SCHEMA = "3xt-fabric-canonical-event/v2";
export const MAX_FABRIC_EVENT_BYTES = 256 * 1024;
export const MAX_FABRIC_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_FABRIC_FUTURE_SKEW_MS = 5 * 60 * 1000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
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
const validHash = value => typeof value === "string" && SHA256.test(value);
const validTaskId = value => typeof value === "string" && TASK_ID.test(value);
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

export function fabricEventContentDigest(input) {
  const event = snapshotJson(input);
  if (!isRecord(event)) throw new TypeError("EVENT_SHAPE_INVALID");
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
  if (!isRecord(event)) return fail("EVENT_SHAPE_INVALID");
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
export function toCanonicalFabricEventV2(input, authenticatedKey) {
  const checked = validateSteelFabricEventV1(input);
  if (!checked.ok) return checked;
  const event = checked.value;
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
export function authorizeSteelFabricEventV1(input, authenticatedKey, policy) {
  const checked = validateSteelFabricEventV1(input);
  if (!checked.ok) return checked;
  const event = checked.value;
  if (!authenticatedKey || authenticatedKey.source_node !== event.source_node || authenticatedKey.key_id !== event.key_id) return fail("AUTHENTICATED_IDENTITY_REQUIRED");
  let trustedPolicy;
  try { trustedPolicy = snapshotJson(policy); } catch { return fail("SOURCE_NOT_AUTHORIZED"); }
  if (!isRecord(trustedPolicy) || trustedPolicy.source_node !== event.source_node || trustedPolicy.status !== "ACTIVE") return fail("SOURCE_NOT_AUTHORIZED");
  if (!Array.isArray(trustedPolicy.destinations) || !trustedPolicy.destinations.includes(event.destination_node)) return fail("DESTINATION_NOT_AUTHORIZED");
  if (!validPolicyList(trustedPolicy.allowed_event_types) || !trustedPolicy.allowed_event_types.includes(event.event_type)) return fail("EVENT_TYPE_NOT_AUTHORIZED");
  if (!validPolicyList(trustedPolicy.allowed_scope) || !event.scope.every(scope => trustedPolicy.allowed_scope.includes(scope))) return fail("SCOPE_NOT_AUTHORIZED");
  if (Number.isSafeInteger(trustedPolicy.max_ttl_ms)) {
    const issued = strictUtcMillis(event.issued_at);
    const expires = strictUtcMillis(event.expires_at);
    if (issued === null || expires === null || expires - issued > trustedPolicy.max_ttl_ms) return fail("EVENT_TTL_NOT_AUTHORIZED");
  }
  if (trustedPolicy.key_id !== undefined && trustedPolicy.key_id !== authenticatedKey.key_id) return fail("KEY_POLICY_MISMATCH");
  return ok(Object.freeze({
    source_node: event.source_node,
    destination_node: event.destination_node,
    effective_scope: Object.freeze([...event.scope]),
    policy_revision: typeof trustedPolicy.revision === "string" ? trustedPolicy.revision : null
  }));
}

/**
 * Durable inbound boundary with a transactionally persisted processing receipt.
 * Duplicate event delivery never re-runs the business handler. When an ACK signer is
 * configured, a signed ACK is persisted per delivery attempt and replayed byte-for-byte.
 * The handler and all local business writes must use the supplied transaction client.
 */
export async function receiveSteelFabricEventV1(pool, raw, deps = {}) {
  const metrics = deps.metrics ?? null;
  if (!pool || typeof pool.connect !== "function") return fail("PERSISTENCE_UNAVAILABLE");
  if (typeof deps.resolveTrustedKey !== "function" || typeof deps.resolveNodePolicy !== "function" || typeof deps.handler !== "function") {
    return fail("INGRESS_DEPENDENCIES_REQUIRED");
  }
  if (!validId(deps.localNodeId)) return fail("LOCAL_NODE_ID_REQUIRED");
  const ackEnabled = typeof deps.createAcknowledgement === "function";
  const deliveryAttempt = deps.deliveryAttempt;
  if (ackEnabled && (!Number.isSafeInteger(deliveryAttempt) || deliveryAttempt < 1)) return fail("DELIVERY_ATTEMPT_REQUIRED");
  if (ackEnabled && typeof deps.lockReceiverSigningIdentity !== "function") return fail("RECEIVER_SIGNING_IDENTITY_LOCKER_REQUIRED");
  if (ackEnabled && typeof deps.revalidateAuthorization !== "function") return fail("INGRESS_AUTHORIZATION_REVALIDATOR_REQUIRED");
  const parsed = parseSteelFabricEventV1(raw);
  if (!parsed.ok) return parsed;
  const event = parsed.value;
  if (event.destination_node !== deps.localNodeId) return fail("DESTINATION_NOT_LOCAL");
  const now = Number((deps.now ?? Date.now)());
  if (!Number.isFinite(now)) return fail("CLOCK_UNAVAILABLE");
  const issuedAt = strictUtcMillis(event.issued_at);
  const expiresAt = strictUtcMillis(event.expires_at);
  if (issuedAt > now + MAX_FABRIC_FUTURE_SKEW_MS) return fail("EVENT_NOT_YET_VALID");

  const authenticated = await authenticateSteelFabricEventV1(event, { resolveTrustedKey: deps.resolveTrustedKey, now: () => now });
  if (!authenticated.ok) return authenticated;
  let policy;
  try { policy = await deps.resolveNodePolicy(event.source_node, authenticated.value, event); } catch { policy = null; }
  const authorized = authorizeSteelFabricEventV1(event, authenticated.value, policy);
  if (!authorized.ok) return authorized;
  let taskId = null;
  const taskEvent = event.event_type.startsWith("factory.task.") || event.event_type.startsWith("task.");
  if (typeof deps.resolveTaskId === "function" || taskEvent || Object.hasOwn(event.payload, "task_id")) {
    try { taskId = typeof deps.resolveTaskId === "function" ? await deps.resolveTaskId(event) : event.payload?.task_id; }
    catch { return fail("TASK_SCOPE_RESOLUTION_FAILED"); }
    if (taskId !== null && taskId !== undefined && !validTaskId(taskId)) return fail("TASK_SCOPE_INVALID");
  }
  if (taskEvent && !validTaskId(taskId)) return fail("TASK_SCOPE_REQUIRED");

  let ackFailureStage = "ACK_NOT_STARTED";
  const ackKeys = ["protocol", "ack_id", "event_id", "source_node", "receiver_node", "source_sequence",
    "event_digest", "delivery_attempt", "result", "policy_revision", "issued_at", "key_id", "content_digest", "signature"];
  const makeOrLoadAck = async (client, authorization, result, ackResult = "ACCEPTED") => {
    ackFailureStage = "ACK_LEDGER_LOOKUP";
    if (!ackEnabled) return null;
    const found = await client.query(
      "SELECT ack_json FROM kratt_fabric_inbound_acknowledgements WHERE event_id=$1 AND delivery_attempt=$2 FOR UPDATE",
      [event.event_id, deliveryAttempt]
    );
    let acknowledgement;
    if (found.rowCount === 1) {
      acknowledgement = found.rows[0].ack_json;
    } else {
      let supplied;
      ackFailureStage = "ACK_BUILDER_CALLBACK";
      try {
        supplied = await deps.createAcknowledgement({
          event, authenticatedKey: authenticated.value, authorization, result,
          outcome: "ACCEPTED", ackResult, deliveryAttempt, receivedAt: new Date(now).toISOString()
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        throw new Error(/^ACK_[A-Z0-9_]{1,96}$/.test(reason) ? reason : "ACK_CALLBACK_THROWN");
      }
      if (supplied?.ok === false) throw new Error(supplied.code ?? "RECEIVER_ACK_CREATION_FAILED");
      acknowledgement = supplied?.ok === true ? supplied.value : supplied;
    }
    ackFailureStage = "ACK_DOCUMENT_VALIDATION";
    if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement) ||
        Object.keys(acknowledgement).length !== ackKeys.length || ackKeys.some(key => !Object.hasOwn(acknowledgement, key)) ||
        acknowledgement.protocol !== "3XT-FABRIC-ACK/1" ||
        !validId(acknowledgement.ack_id) || acknowledgement.event_id !== event.event_id ||
        acknowledgement.source_node !== event.source_node || acknowledgement.receiver_node !== event.destination_node ||
        acknowledgement.source_sequence !== event.sequence || acknowledgement.event_digest !== event.content_digest ||
        acknowledgement.delivery_attempt !== deliveryAttempt ||
        !(ackResult === "REJECTED" ? acknowledgement.result === "REJECTED" :
          ackResult === "DUPLICATE" ? ["ACCEPTED", "DUPLICATE"].includes(acknowledgement.result) : acknowledgement.result === "ACCEPTED") ||
        acknowledgement.policy_revision !== authorization.policy_revision || !validId(acknowledgement.key_id) ||
        strictUtcMillis(acknowledgement.issued_at) === null || !validHash(acknowledgement.content_digest) ||
        typeof acknowledgement.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(acknowledgement.signature))
      throw new Error("RECEIVER_ACK_INVALID");
    ackFailureStage = "ACK_DIGEST_VALIDATION";
    const unsigned = { ...acknowledgement };
    delete unsigned.content_digest;
    delete unsigned.signature;
    const expectedDigest = createHash("sha256").update(canonicalizeFabricJcs(unsigned), "utf8").digest("hex");
    if (expectedDigest !== acknowledgement.content_digest) throw new Error("RECEIVER_ACK_INVALID");
    ackFailureStage = "ACK_SIGNER_RESOLUTION";
    let signerResult;
    try { signerResult = await deps.lockReceiverSigningIdentity(client, event.destination_node, acknowledgement.key_id, acknowledgement, now); }
    catch { throw new Error("RECEIVER_ACK_SIGNER_UNAVAILABLE"); }
    if (signerResult?.ok === false) throw new Error(signerResult.code ?? "RECEIVER_ACK_SIGNER_UNAVAILABLE");
    const signer = signerResult?.ok === true ? signerResult.value : signerResult;
    ackFailureStage = "ACK_SIGNER_LIFECYCLE";
    const ackIssuedAt = strictUtcMillis(acknowledgement.issued_at);
    const trustedNow = Number((deps.now ?? Date.now)());
    const keyValidFrom = signer?.valid_from ? strictUtcMillis(signer.valid_from) : null;
    const signerUsableForAck = signer?.status === "ACTIVE"
      ? keyValidFrom !== null && ackIssuedAt >= keyValidFrom &&
        (!signer.sign_until || (strictUtcMillis(signer.sign_until) !== null && ackIssuedAt <= strictUtcMillis(signer.sign_until)))
      : signer?.status === "VERIFY_ONLY"
        ? keyValidFrom !== null && ackIssuedAt >= keyValidFrom &&
          signer.retired_at && strictUtcMillis(signer.retired_at) !== null && ackIssuedAt <= strictUtcMillis(signer.retired_at) &&
          signer.verify_until && strictUtcMillis(signer.verify_until) !== null && trustedNow <= strictUtcMillis(signer.verify_until)
        : false;
    if (!signer || (signer.node_id ?? signer.source_node) !== event.destination_node ||
        (signer.node_status !== undefined && signer.node_status !== "ACTIVE") ||
        signer.key_id !== acknowledgement.key_id || !signer.public_key || !signerUsableForAck)
      throw new Error("RECEIVER_ACK_SIGNER_UNAVAILABLE");
    ackFailureStage = "ACK_PUBLIC_KEY_IMPORT";
    let publicKey, signatureBytes;
    try {
      publicKey = signer.public_key?.type === "public" ? signer.public_key : createPublicKey(signer.public_key);
      signatureBytes = Buffer.from(acknowledgement.signature, "base64");
    } catch { throw new Error("RECEIVER_ACK_INVALID"); }
    ackFailureStage = "ACK_SIGNATURE_VERIFY";
    const signingInput = ["3XT-FABRIC-ACK/1", acknowledgement.receiver_node, acknowledgement.key_id, acknowledgement.content_digest].join("\n");
    let signatureValid = false;
    try {
      signatureValid = signatureBytes.length === 64 && signatureBytes.toString("base64") === acknowledgement.signature &&
        cryptoVerify(null, Buffer.from(signingInput, "utf8"), publicKey, signatureBytes);
    } catch { signatureValid = false; }
    if (!signatureValid) throw new Error("RECEIVER_ACK_INVALID");
    if (found.rowCount === 0) {
      ackFailureStage = "ACK_LEDGER_INSERT";
      await client.query(
        "INSERT INTO kratt_fabric_inbound_acknowledgements(event_id,delivery_attempt,ack_id,content_digest,ack_json,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
        [event.event_id, deliveryAttempt, acknowledgement.ack_id, acknowledgement.content_digest, JSON.stringify(acknowledgement), new Date(now).toISOString()]
      );
    }
    ackFailureStage = "ACK_COMPLETE";
    return acknowledgement;
  };
  const duplicateResult = async (client, row) => {
    const same = row.event_id === event.event_id && row.source_node === event.source_node &&
      Number(row.source_sequence) === event.sequence && row.content_digest === event.content_digest &&
      row.destination_node === event.destination_node;
    if (!same) return { conflict: true };
    const receipt = await client.query(
      "SELECT outcome,result_json,policy_revision FROM kratt_fabric_receiver_receipts WHERE event_id=$1 FOR UPDATE",
      [event.event_id]
    );
    if (receipt.rowCount !== 1) return { missing: true };
    const stored = receipt.rows[0];
    if (stored.policy_revision !== authorized.value.policy_revision) return { policyChanged: true };
    const storedAuthorization = { ...authorized.value, policy_revision: stored.policy_revision };
    if (ackEnabled) phase = "ACK";
    const duplicateAckResult = stored.outcome === "REJECTED" ? "REJECTED" : "DUPLICATE";
    const acknowledgement = await makeOrLoadAck(client, storedAuthorization, stored.result_json, duplicateAckResult);
    phase = "PERSISTENCE";
    return { value: { duplicate: true, sequence_gap: false, outcome: stored.outcome,
      result: stored.result_json, acknowledgement } };
  };

  let client;
  try { client = await pool.connect(); } catch { return fail("PERSISTENCE_UNAVAILABLE"); }
  let taskCancelled = false;
  let transactionOpen = false;
  let phase = "PERSISTENCE";
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const existing = await client.query(
      `SELECT event_id,source_node,destination_node,source_sequence,content_digest
         FROM kratt_fabric_event_inbox
        WHERE event_id=$1 OR (source_node=$2 AND source_sequence=$3)
        FOR UPDATE`,
      [event.event_id, event.source_node, event.sequence]
    );
    if (existing.rowCount > 1) {
      await client.query("ROLLBACK"); transactionOpen = false;
      return fail("EVENT_REPLAY_OR_CONFLICT");
    }
    if (existing.rowCount === 1) {
      const duplicate = await duplicateResult(client, existing.rows[0]);
      if (duplicate.conflict || duplicate.missing || duplicate.policyChanged) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return fail(duplicate.conflict ? "EVENT_REPLAY_OR_CONFLICT" :
          duplicate.missing ? "EVENT_RECEIPT_MISSING" : "EVENT_RECEIPT_POLICY_REVISION_CHANGED");
      }
      await client.query("COMMIT"); transactionOpen = false;
      incrementFabricMetric(metrics, "fabric_receiver_duplicate_total");
      return ok(duplicate.value);
    }
    // A committed event may need its saved ACK replayed after its original TTL expires.
    // Expiry therefore blocks only first-time processing, not an exact persisted replay.
    if (expiresAt <= now) {
      await client.query("ROLLBACK"); transactionOpen = false;
      return fail("EVENT_EXPIRED");
    }

    await client.query(
      `INSERT INTO kratt_fabric_source_heads (source_node,last_sequence,last_event_id)
       VALUES ($1,0,NULL) ON CONFLICT (source_node) DO NOTHING`,
      [event.source_node]
    );
    const headResult = await client.query(
      `SELECT last_sequence, last_event_id FROM kratt_fabric_source_heads
        WHERE source_node=$1 FOR UPDATE`,
      [event.source_node]
    );
    if (headResult.rowCount !== 1) throw new Error("FABRIC_SOURCE_HEAD_UNAVAILABLE");

    // Re-check after the source watermark lock: concurrent delivery may have committed.
    const racedDuplicate = await client.query(
      `SELECT event_id,source_node,destination_node,source_sequence,content_digest
         FROM kratt_fabric_event_inbox
        WHERE event_id=$1 OR (source_node=$2 AND source_sequence=$3)
        FOR UPDATE`,
      [event.event_id, event.source_node, event.sequence]
    );
    if (racedDuplicate.rowCount > 1) {
      await client.query("ROLLBACK"); transactionOpen = false;
      return fail("EVENT_REPLAY_OR_CONFLICT");
    }
    if (racedDuplicate.rowCount === 1) {
      const duplicate = await duplicateResult(client, racedDuplicate.rows[0]);
      if (duplicate.conflict || duplicate.missing || duplicate.policyChanged) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return fail(duplicate.conflict ? "EVENT_REPLAY_OR_CONFLICT" :
          duplicate.missing ? "EVENT_RECEIPT_MISSING" : "EVENT_RECEIPT_POLICY_REVISION_CHANGED");
      }
      await client.query("COMMIT"); transactionOpen = false;
      incrementFabricMetric(metrics, "fabric_receiver_duplicate_total");
      return ok(duplicate.value);
    }
    const lastSequence = Number(headResult.rows[0].last_sequence);
    if (event.sequence <= lastSequence) {
      await client.query("ROLLBACK"); transactionOpen = false;
      return fail("SEQUENCE_STALE");
    }
    const sequenceGap = event.sequence > lastSequence + 1;
    if (taskId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [taskId]);
      const cancelled = await client.query("SELECT task_id FROM kratt_cancelled_tasks WHERE task_id=$1 FOR UPDATE", [taskId]);
      taskCancelled = cancelled.rowCount > 0;
    }
    let commitAuthorization = authorized.value;
    if (typeof deps.revalidateAuthorization === "function") {
      let live;
      try {
        live = await deps.revalidateAuthorization({
          client, event, authenticatedKey: authenticated.value, authorization: authorized.value, now
        });
      } catch {
        await client.query("ROLLBACK"); transactionOpen = false;
        return fail("AUTHORIZATION_REVALIDATION_UNAVAILABLE");
      }
      if (live?.ok === false) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return fail(live.code ?? "AUTHORIZATION_REVALIDATION_FAILED");
      }
      const livePolicy = live?.ok === true ? (live.value?.policy ?? live.value) : (live?.policy ?? live);
      const reauthorized = authorizeSteelFabricEventV1(event, authenticated.value, livePolicy);
      if (!reauthorized.ok) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return reauthorized;
      }
      if (reauthorized.value.policy_revision !== authorized.value.policy_revision) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return fail("AUTHORIZATION_REVISION_CHANGED");
      }
      commitAuthorization = reauthorized.value;
    }
    if (event.parent_event_id !== null) {
      const parent = await client.query("SELECT event_id FROM kratt_fabric_event_inbox WHERE event_id=$1", [event.parent_event_id]);
      if (parent.rowCount !== 1) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return fail("CAUSAL_PARENT_MISSING");
      }
    }

    await client.query(
      `INSERT INTO kratt_fabric_event_inbox
        (event_id,source_node,destination_node,source_sequence,parent_event_id,content_digest,issued_at,expires_at,event_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [event.event_id,event.source_node,event.destination_node,event.sequence,event.parent_event_id,
       event.content_digest,event.issued_at,event.expires_at,JSON.stringify(event)]
    );
    await client.query(
      `UPDATE kratt_fabric_source_heads
          SET last_sequence=$2,last_event_id=$3,updated_at=clock_timestamp()
        WHERE source_node=$1`,
      [event.source_node,event.sequence,event.event_id]
    );
    const canonical = toCanonicalFabricEventV2(event, authenticated.value);
    if (!canonical.ok) throw new Error(canonical.code);
    if (taskCancelled) {
      const rejectedResult = { code: "TASK_CANCELLED" };
      const rejectedJson = JSON.stringify(rejectedResult);
      const processedAt = new Date(now).toISOString();
      phase = "RECEIPT";
      await client.query(
        `INSERT INTO kratt_fabric_receiver_receipts
          (event_id,source_node,destination_node,source_sequence,content_digest,event_type,source_revision,key_id,policy_revision,outcome,result_json,processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REJECTED',$10::jsonb,$11)`,
        [event.event_id,event.source_node,event.destination_node,event.sequence,event.content_digest,
         event.event_type,event.source_revision,event.key_id,commitAuthorization.policy_revision,rejectedJson,processedAt]
      );
      phase = ackEnabled ? "ACK" : "COMMIT";
      const acknowledgement = await makeOrLoadAck(client, commitAuthorization, rejectedResult, "REJECTED");
      phase = "COMMIT";
      await client.query("COMMIT");
      transactionOpen = false;
      incrementFabricMetric(metrics, "fabric_receiver_rejected_total");
      return ok({ duplicate: false, sequence_gap: sequenceGap, outcome: "REJECTED",
        result: rejectedResult, acknowledgement });
    }
    phase = "HANDLER";
    const handled = await deps.handler(canonical.value, { client, authorization: commitAuthorization, sequence_gap: sequenceGap, task_id: taskId });
    let resultJson;
    try {
      const resultSnapshot = handled === undefined ? null : snapshotJson(handled);
      resultJson = JSON.stringify(resultSnapshot);
      if (typeof resultJson !== "string" || Buffer.byteLength(resultJson, "utf8") > 1024 * 1024) throw new Error("RESULT_SIZE_INVALID");
      JSON.parse(resultJson);
    } catch { throw new Error("EVENT_RESULT_NOT_SERIALIZABLE"); }
    const processedAt = new Date(now).toISOString();
    phase = "RECEIPT";
    await client.query(
      `INSERT INTO kratt_fabric_receiver_receipts
        (event_id,source_node,destination_node,source_sequence,content_digest,event_type,source_revision,key_id,policy_revision,outcome,result_json,processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACCEPTED',$10::jsonb,$11)`,
      [event.event_id,event.source_node,event.destination_node,event.sequence,event.content_digest,
       event.event_type,event.source_revision,event.key_id,commitAuthorization.policy_revision,resultJson,processedAt]
    );
    const storedResult = JSON.parse(resultJson);
    phase = ackEnabled ? "ACK" : "COMMIT";
    const acknowledgement = await makeOrLoadAck(client, commitAuthorization, storedResult);
    phase = "COMMIT";
    await client.query("COMMIT");
    transactionOpen = false;
    incrementFabricMetric(metrics, "fabric_receiver_accepted_total");
    return ok({ duplicate: false, sequence_gap: sequenceGap, outcome: "ACCEPTED",
      result: storedResult, acknowledgement });
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    if (phase === "ACK") {
      const message = error instanceof Error ? error.message : "";
      const sqlState = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
        ? "SQLSTATE_" + error.code : null;
      const isTrustReceiverError = /^TRUST_RECEIVER_(KEY|ACK)_/.test(message);
      const safeException = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
        ? error.name.toUpperCase() : "UNKNOWN_EXCEPTION";
      const safeReference = error instanceof ReferenceError && /^[A-Za-z_$][A-Za-z0-9_$ ]{0,95}$/.test(error.message)
        ? ":" + error.message : "";
      const reason = ["RECEIVER_ACK_INVALID", "RECEIVER_ACK_SIGNER_UNAVAILABLE"].includes(message) || isTrustReceiverError
        ? message
        : /^ACK_[A-Z0-9_]{1,96}$/.test(message) ? message
          : ackFailureStage + ":" + (sqlState ?? safeException) + safeReference;
      if (reason === "RECEIVER_ACK_INVALID" || reason === "RECEIVER_ACK_SIGNER_UNAVAILABLE" || isTrustReceiverError) return fail(reason);
      return fail("RECEIVER_ACK_CREATION_FAILED", reason);
    }
    if (phase === "HANDLER") return fail(error instanceof Error && error.message === "EVENT_RESULT_NOT_SERIALIZABLE"
      ? "EVENT_RESULT_NOT_SERIALIZABLE" : "EVENT_HANDLER_FAILED");
    if (phase === "RECEIPT" || phase === "COMMIT") return fail("EVENT_RECEIPT_STORE_FAILED");
    return fail("PERSISTENCE_UNAVAILABLE", error instanceof Error ? error.message : "database operation failed");
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
  "EVENT_NOT_YET_VALID", "EVENT_EXPIRED", "EVENT_REPLAY_OR_CONFLICT", "EVENT_RECEIPT_MISSING",
  "EVENT_RECEIPT_POLICY_REVISION_CHANGED", "EVENT_RECEIPT_STORE_FAILED", "TASK_SCOPE_RESOLUTION_FAILED",
  "TASK_SCOPE_INVALID", "TASK_SCOPE_REQUIRED", "TASK_CANCELLED", "RECEIVER_SIGNING_IDENTITY_LOCKER_REQUIRED",
  "INGRESS_AUTHORIZATION_REVALIDATOR_REQUIRED", "AUTHORIZATION_REVALIDATION_UNAVAILABLE",
  "AUTHORIZATION_REVALIDATION_FAILED", "AUTHORIZATION_REVISION_CHANGED", "TRUST_INGRESS_REVALIDATION_INPUT_INVALID",
  "TRUST_INGRESS_EVENT_TIME_INVALID", "TRUST_INGRESS_POLICY_OR_NODE_CHANGED", "TRUST_INGRESS_KEY_NOT_USABLE",
  "TRUST_INGRESS_KEY_TIME_INVALID", "TRUST_INGRESS_KEY_SIGN_WINDOW_CLOSED", "TRUST_INGRESS_KEY_VERIFY_WINDOW_CLOSED",
  "TRUST_INGRESS_POLICY_REVISION_CHANGED", "TRUST_INGRESS_REVALIDATION_UNAVAILABLE", "DELIVERY_ATTEMPT_REQUIRED",
  "RECEIVER_ACK_SIGNER_UNAVAILABLE", "RECEIVER_ACK_INVALID",
  "TRUST_RECEIVER_KEY_LOCK_INPUT_INVALID", "TRUST_RECEIVER_ACK_TIME_INVALID", "TRUST_RECEIVER_KEY_UNAVAILABLE",
  "TRUST_RECEIVER_KEY_TIME_INVALID", "TRUST_RECEIVER_KEY_SIGN_WINDOW_CLOSED", "TRUST_RECEIVER_KEY_VERIFY_WINDOW_CLOSED",
  "TRUST_RECEIVER_KEY_LOCK_UNAVAILABLE",
  "RECEIVER_ACK_CREATION_FAILED", "EVENT_RESULT_NOT_SERIALIZABLE", "SEQUENCE_STALE", "CAUSAL_PARENT_MISSING", "EVENT_HANDLER_FAILED"
]);
