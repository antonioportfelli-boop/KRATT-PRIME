import { createHash, createPublicKey, verify } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalizeFabricJcs } from "./fabric-interoperability.mjs";

export const FABRIC_NEGOTIATION_PROTOCOL = "3XT-FABRIC-NEGOTIATE/1";
export const FABRIC_NEGOTIATION_RESPONSE_PROTOCOL = "3XT-FABRIC-NEGOTIATE-RESPONSE/1";
export const FABRIC_RECEIVER_ACK_PROTOCOL = "3XT-FABRIC-ACK/1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REQUEST_KEYS = Object.freeze([
  "protocol", "negotiation_id", "sender_node", "receiver_node", "schema_id",
  "offered_versions", "minimum_version", "policy_revision", "issued_at",
  "expires_at", "key_id", "content_digest", "signature"
]);
const VERSION_KEYS = Object.freeze(["version", "schema_digest"]);
const RESPONSE_KEYS = Object.freeze([
  "protocol", "negotiation_id", "sender_node", "receiver_node", "schema_id",
  "status", "selected_version", "schema_digest", "policy_revision", "request_digest",
  "reason", "issued_at", "key_id", "content_digest", "signature"
]);
const ACK_KEYS = Object.freeze([
  "protocol", "ack_id", "event_id", "source_node", "receiver_node", "source_sequence",
  "event_digest", "delivery_attempt", "result", "policy_revision", "issued_at",
  "key_id", "content_digest", "signature"
]);
const ACK_RESULTS = new Set(["ACCEPTED", "REJECTED", "DUPLICATE", "UNKNOWN"]);

const fail = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });
const ok = value => ({ ok: true, value });
const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value) && !utilTypes.isProxy(value);
const validId = value => typeof value === "string" && ID.test(value);
const validHash = value => typeof value === "string" && SHA256.test(value);

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  return keys.every(key => {
    if (typeof key !== "string" || !expected.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function strictUtc(value) {
  if (typeof value !== "string" || !UTC.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  try {
    const match = UTC.exec(value);
    const normalized = `${match[0].slice(0, 19)}.${(match[0].match(/\.(\d{1,3})Z$/)?.[1] ?? "").padEnd(3, "0")}Z`;
    return new Date(ms).toISOString() === normalized ? ms : null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const aa = VERSION.exec(a)?.slice(1).map(Number);
  const bb = VERSION.exec(b)?.slice(1).map(Number);
  if (!aa || !bb) return null;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

function digestObject(value, excluded) {
  const copy = Object.create(null);
  for (const key of Object.keys(value)) if (!excluded.includes(key)) copy[key] = value[key];
  return createHash("sha256").update(canonicalizeFabricJcs(copy), "utf8").digest("hex");
}

export function fabricSchemaNegotiationRequestDigest(request) {
  return digestObject(request, ["content_digest", "signature"]);
}

export function fabricSchemaNegotiationRequestSigningInput(request) {
  return [FABRIC_NEGOTIATION_PROTOCOL, request.sender_node, request.key_id, request.content_digest].join("\n");
}

export function fabricSchemaNegotiationResponseDigest(response) {
  return digestObject(response, ["content_digest", "signature"]);
}

export function fabricSchemaNegotiationResponseSigningInput(response) {
  return [FABRIC_NEGOTIATION_RESPONSE_PROTOCOL, response.sender_node, response.key_id, response.content_digest].join("\n");
}

export function fabricReceiverAcknowledgementDigest(acknowledgement) {
  return digestObject(acknowledgement, ["content_digest", "signature"]);
}

export function fabricReceiverAcknowledgementSigningInput(acknowledgement) {
  return [FABRIC_RECEIVER_ACK_PROTOCOL, acknowledgement.receiver_node, acknowledgement.key_id, acknowledgement.content_digest].join("\n");
}

export function validateFabricSchemaNegotiationRequest(input) {
  try {
    if (!exactKeys(input, REQUEST_KEYS) || input.protocol !== FABRIC_NEGOTIATION_PROTOCOL) return fail("NEGOTIATION_SCHEMA_INVALID");
    if (![input.negotiation_id, input.sender_node, input.receiver_node, input.schema_id, input.key_id, input.policy_revision].every(validId))
      return fail("NEGOTIATION_IDENTITY_INVALID");
    if (!VERSION.test(input.minimum_version) || !Array.isArray(input.offered_versions) ||
      input.offered_versions.length < 1 || input.offered_versions.length > 16) return fail("NEGOTIATION_VERSIONS_INVALID");
    const versions = new Set();
    for (const item of input.offered_versions) {
      if (!exactKeys(item, VERSION_KEYS) || !VERSION.test(item.version) || !validHash(item.schema_digest) || versions.has(item.version))
        return fail("NEGOTIATION_VERSIONS_INVALID");
      versions.add(item.version);
    }
    const issued = strictUtc(input.issued_at), expires = strictUtc(input.expires_at);
    if (issued === null || expires === null || expires <= issued || expires - issued > 10 * 60 * 1000)
      return fail("NEGOTIATION_TIME_INVALID");
    if (!validHash(input.content_digest) || typeof input.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) return fail("NEGOTIATION_INTEGRITY_INVALID");
    if (fabricSchemaNegotiationRequestDigest(input) !== input.content_digest) return fail("NEGOTIATION_DIGEST_MISMATCH");
    return ok(Object.freeze({ ...input, offered_versions: Object.freeze(input.offered_versions.map(v => Object.freeze({ ...v }))) }));
  } catch {
    return fail("NEGOTIATION_SCHEMA_INVALID");
  }
}

export function validateFabricSchemaNegotiationResponse(input) {
  try {
    if (!exactKeys(input, RESPONSE_KEYS) || input.protocol !== FABRIC_NEGOTIATION_RESPONSE_PROTOCOL) return fail("NEGOTIATION_RESPONSE_INVALID");
    if (![input.negotiation_id, input.sender_node, input.receiver_node, input.schema_id, input.key_id].every(validId) ||
      !validHash(input.request_digest) || !validHash(input.content_digest) ||
      !["SUPPORTED", "UNSUPPORTED", "UNKNOWN"].includes(input.status)) return fail("NEGOTIATION_RESPONSE_INVALID");
    if (input.status === "SUPPORTED") {
      if (!VERSION.test(input.selected_version) || !validHash(input.schema_digest) || !validId(input.policy_revision) || input.reason !== null)
        return fail("NEGOTIATION_RESPONSE_INVALID");
    } else if (input.selected_version !== null || input.schema_digest !== null) {
      return fail("NEGOTIATION_RESPONSE_INVALID");
    }
    if (strictUtc(input.issued_at) === null || typeof input.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature))
      return fail("NEGOTIATION_RESPONSE_INVALID");
    if (fabricSchemaNegotiationResponseDigest(input) !== input.content_digest) return fail("NEGOTIATION_RESPONSE_DIGEST_MISMATCH");
    return ok(Object.freeze({ ...input }));
  } catch {
    return fail("NEGOTIATION_RESPONSE_INVALID");
  }
}


export async function authenticateFabricSchemaNegotiationResponse(input, {
  expectedReceiverNode, expectedSenderNode, expectedNegotiationId, expectedRequestDigest,
  resolveTrustedKey, now = () => Date.now()
} = {}) {
  const parsed = validateFabricSchemaNegotiationResponse(input);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  if (!validId(expectedReceiverNode) || response.sender_node !== expectedReceiverNode ||
      !validId(expectedSenderNode) || response.receiver_node !== expectedSenderNode)
    return fail("NEGOTIATION_RESPONSE_IDENTITY_MISMATCH");
  if (!validId(expectedNegotiationId) || response.negotiation_id !== expectedNegotiationId ||
      !validHash(expectedRequestDigest) || response.request_digest !== expectedRequestDigest)
    return fail("NEGOTIATION_RESPONSE_REQUEST_BINDING_MISMATCH");
  if (typeof resolveTrustedKey !== "function") return fail("NEGOTIATION_RESPONSE_TRUST_RESOLVER_REQUIRED");
  const nowMs = Number(now()), issued = strictUtc(response.issued_at);
  if (!Number.isFinite(nowMs) || issued > nowMs + 5 * 60 * 1000 || issued < nowMs - 24 * 60 * 60 * 1000)
    return fail("NEGOTIATION_RESPONSE_TIME_INVALID");
  let identity;
  try { identity = await resolveTrustedKey(response.sender_node, response.key_id); }
  catch { return fail("NEGOTIATION_RESPONSE_KEY_UNAVAILABLE"); }
  const authenticated = verifyTrustedSignature({
    identity, nodeId: response.sender_node, keyId: response.key_id, issuedAt: response.issued_at,
    content: response.content_digest, signature: response.signature,
    domainInput: fabricSchemaNegotiationResponseSigningInput(response), nowMs
  });
  if (!authenticated.ok) return fail("NEGOTIATION_RESPONSE_" + authenticated.code);
  return ok({ response, authenticatedReceiver: authenticated.value });
}

function publicKeyOf(value) {
  try {
    if (value && typeof value === "object" && value.type === "public") return value;
    if (typeof value === "string" || Buffer.isBuffer(value)) return createPublicKey(value);
  } catch {
    return null;
  }
  return null;
}

function verifyTrustedSignature({ identity, nodeId, keyId, issuedAt, content, signature, domainInput, nowMs }) {
  if (!identity || (identity.node_id ?? identity.source_node) !== nodeId || identity.key_id !== keyId || !["ACTIVE", "VERIFY_ONLY"].includes(identity.status) ||
    (identity.node_status !== undefined && identity.node_status !== "ACTIVE")) return fail("ACK_KEY_UNTRUSTED");
  const issued = strictUtc(issuedAt);
  const validFrom = identity.valid_from ? Date.parse(identity.valid_from) : -Infinity;
  const signUntil = identity.sign_until ? Date.parse(identity.sign_until) : Infinity;
  if (issued === null || issued < validFrom || issued > signUntil) return fail("ACK_KEY_OUTSIDE_VALIDITY");
  if (identity.status === "VERIFY_ONLY") {
    const retired = identity.retired_at ? Date.parse(identity.retired_at) : NaN;
    const verifyUntil = identity.verify_until ? Date.parse(identity.verify_until) : NaN;
    if (!Number.isFinite(retired) || !Number.isFinite(verifyUntil) || issued > retired || nowMs > verifyUntil)
      return fail("ACK_KEY_RETIRED");
  }
  const key = publicKeyOf(identity.public_key);
  let signatureBytes;
  try { signatureBytes = Buffer.from(signature, "base64"); } catch { return fail("ACK_SIGNATURE_INVALID"); }
  if (!key || signatureBytes.toString("base64") !== signature ||
    !verify(null, Buffer.from(domainInput, "utf8"), key, signatureBytes)) return fail("ACK_SIGNATURE_INVALID");
  return ok({ node_id: identity.node_id ?? identity.source_node, key_id: keyId, status: identity.status, content_digest: content });
}

export async function negotiateFabricSchema(requestInput, {
  localNodeId, resolveTrustedKey, resolveSchemaPolicy, resolveSigningIdentity, sign,
  now = () => Date.now()
} = {}) {
  const parsed = validateFabricSchemaNegotiationRequest(requestInput);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (!validId(localNodeId) || request.receiver_node !== localNodeId) return fail("NEGOTIATION_WRONG_RECEIVER");
  if (typeof resolveTrustedKey !== "function" || typeof resolveSchemaPolicy !== "function" ||
    typeof resolveSigningIdentity !== "function" || typeof sign !== "function") return fail("NEGOTIATION_DEPENDENCY_MISSING");
  const nowMs = Number(now());
  const issued = strictUtc(request.issued_at), expires = strictUtc(request.expires_at);
  if (!Number.isFinite(nowMs) || issued > nowMs + 5 * 60 * 1000 || expires <= nowMs) return fail("NEGOTIATION_EXPIRED");
  let trusted;
  try { trusted = await resolveTrustedKey(request.sender_node, request.key_id); } catch { return fail("NEGOTIATION_KEY_UNAVAILABLE"); }
  const auth = verifyTrustedSignature({
    identity: trusted, nodeId: request.sender_node, keyId: request.key_id, issuedAt: request.issued_at,
    content: request.content_digest, signature: request.signature,
    domainInput: fabricSchemaNegotiationRequestSigningInput(request), nowMs
  });
  if (!auth.ok) return fail("NEGOTIATION_" + auth.code);
  let policy;
  try { policy = await resolveSchemaPolicy({ senderNode: request.sender_node, receiverNode: localNodeId, schemaId: request.schema_id, identity: auth.value }); }
  catch { return fail("NEGOTIATION_POLICY_UNAVAILABLE"); }

  let status = "UNKNOWN", reason = "SCHEMA_UNKNOWN", selected = null, policyRevision = null;
  if (policy) {
    policyRevision = validId(policy.revision) ? policy.revision : null;
    if (policy.status !== "ACTIVE") {
      status = "UNSUPPORTED"; reason = "SCHEMA_POLICY_DISABLED";
    } else if (!policyRevision || request.policy_revision !== policyRevision) {
      status = "UNSUPPORTED"; reason = "POLICY_REVISION_MISMATCH";
    } else {
      const floor = policy.minimum_version ?? request.minimum_version;
      if (!VERSION.test(floor)) return fail("NEGOTIATION_POLICY_INVALID");
      const allowed = Array.isArray(policy.supported_versions) ? policy.supported_versions : [];
      const candidates = request.offered_versions.filter(offered => {
        const registered = allowed.find(item => item?.version === offered.version && item?.schema_digest === offered.schema_digest && item?.status !== "DISABLED");
        return registered && (registered.status === undefined || registered.status === "ACTIVE") && compareVersions(offered.version, request.minimum_version) >= 0 &&
          compareVersions(offered.version, floor) >= 0;
      }).sort((a, b) => compareVersions(b.version, a.version));
      if (candidates.length) {
        status = "SUPPORTED"; reason = null; selected = candidates[0];
      } else {
        status = "UNSUPPORTED"; reason = "NO_COMMON_ALLOWED_VERSION";
      }
    }
  }

  let signingIdentity;
  try { signingIdentity = await resolveSigningIdentity(localNodeId); } catch { return fail("NEGOTIATION_RESPONSE_SIGNER_UNAVAILABLE"); }
  if (!signingIdentity || (signingIdentity.node_id ?? signingIdentity.source_node) !== localNodeId || signingIdentity.status !== "ACTIVE" ||
    !validId(signingIdentity.key_id) || !publicKeyOf(signingIdentity.public_key)) return fail("NEGOTIATION_RESPONSE_SIGNER_UNAVAILABLE");
  const response = {
    protocol: FABRIC_NEGOTIATION_RESPONSE_PROTOCOL,
    negotiation_id: request.negotiation_id,
    sender_node: localNodeId,
    receiver_node: request.sender_node,
    schema_id: request.schema_id,
    status,
    selected_version: selected?.version ?? null,
    schema_digest: selected?.schema_digest ?? null,
    policy_revision: policyRevision,
    request_digest: request.content_digest,
    reason,
    issued_at: new Date(nowMs).toISOString(),
    key_id: signingIdentity.key_id,
    content_digest: ""
  };
  response.content_digest = fabricSchemaNegotiationResponseDigest(response);
  let signature;
  try { signature = await sign({ message: fabricSchemaNegotiationResponseSigningInput(response), identity: signingIdentity }); }
  catch { return fail("NEGOTIATION_RESPONSE_SIGNING_FAILED"); }
  response.signature = Buffer.isBuffer(signature) ? signature.toString("base64") : signature;
  const checked = validateFabricSchemaNegotiationResponse(response);
  if (!checked.ok) return checked;
  const validSignature = verify(null, Buffer.from(fabricSchemaNegotiationResponseSigningInput(response), "utf8"),
    publicKeyOf(signingIdentity.public_key), Buffer.from(response.signature, "base64"));
  if (!validSignature) return fail("NEGOTIATION_RESPONSE_SIGNATURE_INVALID");
  return ok(checked.value);
}

export function validateFabricReceiverAcknowledgement(input) {
  try {
    if (!exactKeys(input, ACK_KEYS) || input.protocol !== FABRIC_RECEIVER_ACK_PROTOCOL) return fail("ACK_SCHEMA_INVALID");
    if (![input.ack_id, input.event_id, input.source_node, input.receiver_node, input.key_id, input.policy_revision].every(validId))
      return fail("ACK_IDENTITY_INVALID");
    if (!Number.isSafeInteger(input.source_sequence) || input.source_sequence < 1 ||
      !Number.isSafeInteger(input.delivery_attempt) || input.delivery_attempt < 1 ||
      !validHash(input.event_digest) || !ACK_RESULTS.has(input.result) ||
      strictUtc(input.issued_at) === null || !validHash(input.content_digest) ||
      typeof input.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature))
      return fail("ACK_FIELDS_INVALID");
    if (fabricReceiverAcknowledgementDigest(input) !== input.content_digest) return fail("ACK_DIGEST_MISMATCH");
    return ok(Object.freeze({ ...input }));
  } catch {
    return fail("ACK_SCHEMA_INVALID");
  }
}

export async function authenticateFabricReceiverAcknowledgement(input, {
  expectedReceiverNode, expectedPolicyRevision, resolveTrustedKey, now = () => Date.now()
} = {}) {
  const parsed = validateFabricReceiverAcknowledgement(input);
  if (!parsed.ok) return parsed;
  const ack = parsed.value;
  if (!validId(expectedReceiverNode) || ack.receiver_node !== expectedReceiverNode) return fail("ACK_WRONG_RECEIVER");
  if (!validId(expectedPolicyRevision) || ack.policy_revision !== expectedPolicyRevision) return fail("ACK_POLICY_REVISION_MISMATCH");
  if (typeof resolveTrustedKey !== "function") return fail("ACK_TRUST_RESOLVER_REQUIRED");
  const nowMs = Number(now()), issued = strictUtc(ack.issued_at);
  if (!Number.isFinite(nowMs) || issued > nowMs + 5 * 60 * 1000 || issued < nowMs - 24 * 60 * 60 * 1000)
    return fail("ACK_TIME_INVALID");
  let identity;
  try { identity = await resolveTrustedKey(ack.receiver_node, ack.key_id); }
  catch { return fail("ACK_KEY_UNAVAILABLE"); }
  const auth = verifyTrustedSignature({
    identity, nodeId: ack.receiver_node, keyId: ack.key_id, issuedAt: ack.issued_at, content: ack.content_digest,
    signature: ack.signature, domainInput: fabricReceiverAcknowledgementSigningInput(ack), nowMs
  });
  if (!auth.ok) return auth;
  return ok({ acknowledgement: ack, authenticatedReceiver: auth.value, receivedAt: new Date(nowMs).toISOString() });
}

export async function processFabricReceiverAcknowledgement({
  acknowledgement, expectedReceiverNode, expectedPolicyRevision, resolveTrustedKey, acknowledgementStore,
  outboxId, leaseToken, now = () => Date.now()
} = {}) {
  if (!acknowledgementStore || typeof acknowledgementStore.applyReceiverAcknowledgement !== "function")
    return fail("ACK_STORE_REQUIRED");
  if (!validId(outboxId) || typeof leaseToken !== "string" || leaseToken.length < 16 || leaseToken.length > 128)
    return fail("ACK_DELIVERY_CONTEXT_INVALID");
  const authenticated = await authenticateFabricReceiverAcknowledgement(acknowledgement, {
    expectedReceiverNode, expectedPolicyRevision, resolveTrustedKey, now
  });
  if (!authenticated.ok) return authenticated;
  try {
    const stored = await acknowledgementStore.applyReceiverAcknowledgement({
      outboxId, leaseToken, acknowledgement: authenticated.value.acknowledgement,
      authenticatedReceiver: authenticated.value.authenticatedReceiver,
      receivedAt: authenticated.value.receivedAt
    });
    return stored?.ok === true ? ok(stored) : fail(stored?.reason ?? "ACK_STORE_REJECTED");
  } catch {
    return fail("ACK_STORE_UNAVAILABLE");
  }
}

export const FABRIC_NEGOTIATION_ACK_ERROR_CODES = Object.freeze([
  "NEGOTIATION_SCHEMA_INVALID", "NEGOTIATION_IDENTITY_INVALID", "NEGOTIATION_VERSIONS_INVALID",
  "NEGOTIATION_TIME_INVALID", "NEGOTIATION_INTEGRITY_INVALID", "NEGOTIATION_DIGEST_MISMATCH",
  "NEGOTIATION_WRONG_RECEIVER", "NEGOTIATION_EXPIRED", "NEGOTIATION_POLICY_UNAVAILABLE",
  "NEGOTIATION_KEY_UNAVAILABLE", "NEGOTIATION_NO_COMMON_ALLOWED_VERSION", "ACK_SCHEMA_INVALID",
  "ACK_IDENTITY_INVALID", "ACK_FIELDS_INVALID", "ACK_DIGEST_MISMATCH", "ACK_WRONG_RECEIVER",
  "ACK_KEY_UNAVAILABLE", "ACK_SIGNATURE_INVALID", "ACK_TIME_INVALID", "ACK_STORE_REJECTED"
]);
