import { createHash, verify as cryptoVerify } from "node:crypto";
import { canonicalTaskDigest } from "./policy.mjs";
import { validateTaskEnvelope } from "./contracts.mjs";
import {
  FABRIC_WIRE_PROTOCOL, MAX_FABRIC_EVENT_BYTES, MAX_FABRIC_EVENT_TTL_MS,
  canonicalizeFabricJcs, fabricEventContentDigest, fabricSigningInput,
  validateSteelFabricEventV1
} from "./fabric-interoperability.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TOKEN = /^[a-z][a-z0-9._:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const IDEMPOTENCY = /^kratt:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}:[a-f0-9]{64}$/;
const MAX_APPROVAL_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;

const fail = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });
const ok = value => ({ ok: true, value });
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const validTime = value => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try {
    return new Date(milliseconds).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  } catch {
    return false;
  }
};

function immutableJsonRecord(value) {
  let serialized;
  try { serialized = canonicalizeFabricJcs(value); } catch { return null; }
  let copy;
  try { copy = JSON.parse(serialized); } catch { return null; }
  return copy && typeof copy === "object" && !Array.isArray(copy) ? copy : null;
}

function listOfTokens(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64 &&
    value.every(item => typeof item === "string" && TOKEN.test(item)) &&
    new Set(value).size === value.length;
}

function snapshotReferenceList(value) {
  let copy;
  try { copy = JSON.parse(canonicalizeFabricJcs(value)); } catch { return null; }
  return Array.isArray(copy) && copy.length <= 64 &&
    copy.every(item => typeof item === "string" && item.length >= 1 && item.length <= 512) &&
    new Set(copy).size === copy.length ? copy : null;
}

function validApprovalShape(approval) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
  const fields = ["schema_version","approval_id","task_id","actor","provider","operation","target","request_digest","key_id","nonce","issued_at","expires_at","decision","approved_by","authority","signature"];
  const keys = Reflect.ownKeys(approval);
  if (keys.some(key => typeof key !== "string" || !fields.includes(key))) return false;
  if (fields.some(key => !Object.hasOwn(approval,key))) return false;
  const dataOnly = keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(approval,key);
    return descriptor && Object.hasOwn(descriptor,"value") && descriptor.enumerable;
  });
  return dataOnly && approval.schema_version === "kratt-prime/v0.1" && PRINCIPAL_ID.test(approval.approved_by ?? "") &&
    approval.target && typeof approval.target === "object" && !Array.isArray(approval.target) &&
    Reflect.ownKeys(approval.target).length === 2 &&
    ["resource_type","resource_id"].every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(approval.target,key);
      return descriptor && Object.hasOwn(descriptor,"value") && descriptor.enumerable;
    });
}

function existingReservation(existing, expectedEventId, sourceNode) {
  if (!existing?.ok || existing.found !== true || !existing.event) return null;
  const checked = validateSteelFabricEventV1(existing.event);
  if (!checked.ok || checked.value.event_id !== expectedEventId || checked.value.source_node !== sourceNode) return null;
  return {
    duplicate: true,
    queued: true,
    outbox_status: existing.status,
    attempts: existing.attempts,
    event: checked.value
  };
}

/**
 * Build and durably reserve a signed 3XT-FABRIC/1 event.
 *
 * All policy, payload, evidence and key material resolvers are server-owned dependencies.
 * This method only creates an outbox record; it never claims or dispatches it.
 */
export function createSteelFabricOutboundAdapter({
  outboxStore,
  sourceNode,
  resolveSourceRevision,
  resolveOutboundPolicy,
  resolveSigningIdentity,
  sign,
  verifyApproval,
  resolvePayload,
  resolveEvidenceReferences = async () => [],
  resolveCorrelationId = async task => `corr:${task.task_id}`,
  resolveCausalParent = async () => null,
  resolvePayloadReference = async () => null,
  now = () => Date.now()
} = {}) {
  if (!outboxStore || typeof outboxStore.reserveFabricSequence !== "function" ||
      typeof outboxStore.reserveAuthorizedIntent !== "function" ||
      typeof outboxStore.findOutboxByIdempotencyKey !== "function") throw new TypeError("FABRIC_OUTBOX_STORE_REQUIRED");
  if (!ID.test(sourceNode ?? "") || typeof resolveSourceRevision !== "function" ||
      typeof resolveOutboundPolicy !== "function" || typeof resolveSigningIdentity !== "function" ||
      typeof sign !== "function" || typeof verifyApproval !== "function" || typeof resolvePayload !== "function" ||
      typeof resolveEvidenceReferences !== "function" || typeof resolveCorrelationId !== "function" ||
      typeof resolveCausalParent !== "function" || typeof resolvePayloadReference !== "function" ||
      typeof now !== "function") throw new TypeError("FABRIC_OUTBOUND_DEPENDENCIES_REQUIRED");

  async function publish({ task: taskInput, principal, approval, idempotencyKey, eventType } = {}) {
    const taskResult = validateTaskEnvelope(taskInput);
    if (!taskResult.ok) return fail("TASK_ENVELOPE_INVALID");
    const task = taskResult.value;
    if (!principal || typeof principal.id !== "string" || !PRINCIPAL_ID.test(principal.id) || principal.id !== task.actor) {
      return fail("PRINCIPAL_MISMATCH");
    }
    if (!IDEMPOTENCY.test(idempotencyKey ?? "")) return fail("IDEMPOTENCY_KEY_INVALID");
    const taskDigest = canonicalTaskDigest(task);
    if (typeof taskDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(taskDigest)) return fail("TASK_DIGEST_UNAVAILABLE");
    const taskDigestHex = taskDigest.slice(7);
    if (idempotencyKey !== `kratt:${task.task_id}:${taskDigestHex}`) return fail("IDEMPOTENCY_KEY_TASK_BINDING_MISMATCH");
    approval = immutableJsonRecord(approval);
    if (!approval || !validApprovalShape(approval)) return fail("REQUEST_BOUND_APPROVAL_INVALID");

    let current;
    try { current = Number(now()); } catch { return fail("CLOCK_UNAVAILABLE"); }
    if (!Number.isFinite(current)) return fail("CLOCK_UNAVAILABLE");
    const issuedApproval = Date.parse(approval.issued_at);
    const expiresApproval = Date.parse(approval.expires_at);
    if (!validTime(approval.issued_at) || !validTime(approval.expires_at) ||
        issuedApproval > current + CLOCK_SKEW_MS || expiresApproval <= current ||
        expiresApproval <= issuedApproval || expiresApproval - issuedApproval > MAX_APPROVAL_AGE_MS ||
        current - issuedApproval > MAX_APPROVAL_AGE_MS) return fail("APPROVAL_TIME_INVALID");
    if (approval.task_id !== task.task_id || approval.actor !== principal.id ||
        approval.operation !== task.action || approval.target?.resource_type !== task.target.resource_type ||
        approval.target?.resource_id !== task.target.resource_id || approval.request_digest !== taskDigest ||
        approval.decision !== "APPROVE" || typeof approval.signature !== "string" ||
        approval.signature.length < 1 || approval.signature.length > 8192 ||
        !ID.test(approval.approval_id ?? "") || !ID.test(approval.key_id ?? "") ||
        !ID.test(approval.nonce ?? "")) return fail("APPROVAL_BINDING_MISMATCH");

    let policyRaw;
    try { policyRaw = await resolveOutboundPolicy({ task, principal, eventType }); } catch { policyRaw = null; }
    const policy = immutableJsonRecord(policyRaw);
    if (!policy || policy.status !== "ACTIVE" || policy.source_node !== sourceNode ||
        !ID.test(policy.destination_node ?? "") || !Array.isArray(policy.allowed_event_types) ||
        !policy.allowed_event_types.includes(eventType) || typeof eventType !== "string" || !TOKEN.test(eventType)) {
      return fail("OUTBOUND_POLICY_DENIED");
    }
    const scope = policy.scope_by_event_type?.[eventType];
    if (!listOfTokens(scope)) return fail("OUTBOUND_SCOPE_POLICY_INVALID");
    const approvalProvider = policy.approval_provider ?? "fabric";
    if (!ID.test(approvalProvider) || approval.provider !== approvalProvider ||
        approval.authority !== policy.approval_authority || !ID.test(policy.approval_authority ?? "")) {
      return fail("APPROVAL_POLICY_BINDING_MISMATCH");
    }
    const approvalBinding = {
      task_id: task.task_id,
      actor: principal.id,
      provider: approvalProvider,
      operation: task.action,
      target: task.target,
      authority: policy.approval_authority,
      request_digest: taskDigest
    };
    let approved = false;
    try { approved = await verifyApproval(approval, approvalBinding) === true; } catch { approved = false; }
    if (!approved) return fail("APPROVAL_SIGNATURE_INVALID");

    let sourceRevision;
    try { sourceRevision = await resolveSourceRevision({ task, principal }); } catch { sourceRevision = null; }
    if (typeof sourceRevision !== "string" || !SHA1.test(sourceRevision)) return fail("SOURCE_REVISION_UNAVAILABLE");

    let identity;
    try { identity = await resolveSigningIdentity(sourceNode); } catch { identity = null; }
    if (!identity || identity.source_node !== sourceNode || !ID.test(identity.key_id ?? "") ||
        identity.status !== "ACTIVE" || !identity.public_key) return fail("OUTBOUND_SIGNING_KEY_UNAVAILABLE");
    if (identity.valid_from !== undefined && (!validTime(identity.valid_from) || current < Date.parse(identity.valid_from))) {
      return fail("OUTBOUND_SIGNING_KEY_NOT_YET_VALID");
    }
    if (identity.sign_until !== undefined && (!validTime(identity.sign_until) || current > Date.parse(identity.sign_until))) {
      return fail("OUTBOUND_SIGNING_KEY_WINDOW_CLOSED");
    }
    if (policy.key_id !== undefined && policy.key_id !== identity.key_id) return fail("OUTBOUND_SIGNING_KEY_POLICY_MISMATCH");

    let payloadRaw, evidenceRaw, correlationId, parentEventId, payloadReference;
    try {
      [payloadRaw,evidenceRaw,correlationId,parentEventId,payloadReference] = await Promise.all([
        resolvePayload({ task, principal, eventType }),
        resolveEvidenceReferences({ task, principal, eventType }),
        resolveCorrelationId(task, principal),
        resolveCausalParent({ task, principal, eventType }),
        resolvePayloadReference({ task, principal, eventType })
      ]);
    } catch { return fail("OUTBOUND_CONTEXT_UNAVAILABLE"); }
    const payload = immutableJsonRecord(payloadRaw);
    if (!payload) return fail("OUTBOUND_PAYLOAD_INVALID");
    const evidenceReferences = snapshotReferenceList(evidenceRaw);
    if (!evidenceReferences) return fail("OUTBOUND_EVIDENCE_REFERENCES_INVALID");
    if (typeof correlationId !== "string" || !ID.test(correlationId)) return fail("CORRELATION_ID_INVALID");
    if (parentEventId !== null && (typeof parentEventId !== "string" || !ID.test(parentEventId))) return fail("CAUSAL_PARENT_INVALID");
    if (payloadReference !== null && (typeof payloadReference !== "string" || payloadReference.length < 1 || payloadReference.length > 512)) {
      return fail("PAYLOAD_REFERENCE_INVALID");
    }

    const ttlMs = policy.max_ttl_ms ?? 5 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_FABRIC_EVENT_TTL_MS) return fail("OUTBOUND_TTL_POLICY_INVALID");
    const eventId = `evt:${sha256(idempotencyKey)}`;
    const reservationMaterial = {
      task_digest: taskDigest,
      source_node: sourceNode,
      destination_node: policy.destination_node,
      source_revision: sourceRevision,
      event_type: eventType,
      scope,
      correlation_id: correlationId,
      parent_event_id: parentEventId,
      payload_reference: payloadReference,
      evidence_references: evidenceReferences,
      max_ttl_ms: ttlMs,
      approval_authority: policy.approval_authority,
      payload,
      key_id: identity.key_id,
      policy_revision: typeof policy.revision === "string" ? policy.revision : null
    };
    const reservationDigest = sha256(canonicalizeFabricJcs(reservationMaterial));

    let prior;
    try { prior = await outboxStore.findOutboxByIdempotencyKey(idempotencyKey); } catch { return fail("OUTBOX_LOOKUP_UNAVAILABLE"); }
    if (!prior?.ok) return fail(prior?.reason ?? "OUTBOX_LOOKUP_FAILED");
    if (prior.found) {
      const duplicate = existingReservation(prior, eventId, sourceNode);
      return duplicate ? ok(duplicate) : fail("IDEMPOTENCY_RESERVATION_CONFLICT");
    }

    let sequenceReservation;
    try {
      sequenceReservation = await outboxStore.reserveFabricSequence({
        sourceNode, idempotencyKey, requestDigest: reservationDigest
      });
    } catch { return fail("FABRIC_SEQUENCE_RESERVATION_FAILED"); }
    if (!sequenceReservation?.ok || !Number.isSafeInteger(sequenceReservation.sequence) ||
        sequenceReservation.sequence < 1) return fail(sequenceReservation?.reason ?? "FABRIC_SEQUENCE_RESERVATION_FAILED");

    const issuedAt = new Date(current).toISOString();
    const expiresAt = new Date(current + ttlMs).toISOString();
    const unsigned = {
      protocol: FABRIC_WIRE_PROTOCOL,
      event_id: eventId,
      event_type: eventType,
      source_node: sourceNode,
      destination_node: policy.destination_node,
      source_revision: sourceRevision,
      correlation_id: correlationId,
      parent_event_id: parentEventId,
      sequence: sequenceReservation.sequence,
      issued_at: issuedAt,
      expires_at: expiresAt,
      scope: [...scope],
      payload_reference: payloadReference,
      evidence_references: [...evidenceReferences],
      key_id: identity.key_id,
      payload,
      content_digest: "",
      signature: ""
    };
    let contentDigest;
    try { contentDigest = fabricEventContentDigest(unsigned); } catch { return fail("OUTBOUND_DIGEST_FAILED"); }
    const signingEvent = { ...unsigned, content_digest: contentDigest };
    let signature;
    try { signature = await sign({ identity, message: fabricSigningInput(signingEvent) }); } catch { signature = null; }
    if (typeof signature !== "string" || signature.length > 128) return fail("OUTBOUND_SIGNATURE_FAILED");
    let signatureBytes;
    try { signatureBytes = Buffer.from(signature, "base64"); } catch { return fail("OUTBOUND_SIGNATURE_INVALID"); }
    if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) return fail("OUTBOUND_SIGNATURE_INVALID");
    let signatureVerified = false;
    try {
      signatureVerified = cryptoVerify(null, Buffer.from(fabricSigningInput(signingEvent), "utf8"), identity.public_key, signatureBytes);
    } catch { signatureVerified = false; }
    if (!signatureVerified) return fail("OUTBOUND_SIGNATURE_KEY_MISMATCH");

    const event = { ...signingEvent, signature };
    const checkedEvent = validateSteelFabricEventV1(event);
    if (!checkedEvent.ok) return fail("OUTBOUND_EVENT_INVALID", checkedEvent.code);
    if (Buffer.byteLength(JSON.stringify(checkedEvent.value), "utf8") > MAX_FABRIC_EVENT_BYTES) return fail("OUTBOUND_EVENT_TOO_LARGE");

    const storedApproval = {
      key_id: approval.key_id,
      nonce: approval.nonce,
      approval_id: approval.approval_id,
      expires_at: approval.expires_at,
      request_digest: taskDigestHex,
      signature_digest: sha256(approval.signature)
    };
    let reserved;
    try {
      reserved = await outboxStore.reserveAuthorizedIntent({
        task, principal, approval: storedApproval, idempotencyKey,
        provider: "fabric", fabricEvent: checkedEvent.value,
        providerPayload: { fabric_envelope: checkedEvent.value }
      });
    } catch { return fail("OUTBOX_RESERVATION_FAILED"); }
    if (!reserved?.ok) {
      let raced;
      try { raced = await outboxStore.findOutboxByIdempotencyKey(idempotencyKey); } catch { raced = null; }
      const duplicate = existingReservation(raced, eventId, sourceNode);
      return duplicate ? ok(duplicate) : fail(reserved?.reason ?? "OUTBOX_RESERVATION_FAILED");
    }
    return ok({
      duplicate: false,
      queued: true,
      outbox_id: reserved.outbox_id,
      audit_sequence: reserved.audit_sequence,
      sequence: checkedEvent.value.sequence,
      policy_revision: typeof policy.revision === "string" ? policy.revision : null,
      event: checkedEvent.value
    });
  }

  return Object.freeze({ publish });
}
