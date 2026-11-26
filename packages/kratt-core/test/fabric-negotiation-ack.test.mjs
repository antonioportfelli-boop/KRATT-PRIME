import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import {
  FABRIC_NEGOTIATION_PROTOCOL,
  FABRIC_NEGOTIATION_RESPONSE_PROTOCOL,
  FABRIC_RECEIVER_ACK_PROTOCOL,
  fabricSchemaNegotiationRequestDigest,
  fabricSchemaNegotiationRequestSigningInput,
  fabricSchemaNegotiationResponseDigest,
  fabricSchemaNegotiationResponseSigningInput,
  fabricReceiverAcknowledgementDigest,
  fabricReceiverAcknowledgementSigningInput,
  validateFabricSchemaNegotiationRequest,
  validateFabricSchemaNegotiationResponse,
  validateFabricReceiverAcknowledgement,
  negotiateFabricSchema,
  authenticateFabricSchemaNegotiationResponse,
  authenticateFabricReceiverAcknowledgement,
  processFabricReceiverAcknowledgement
} from "../src/fabric-negotiation-ack.mjs";

const NOW = Date.parse("2026-11-26T17:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const sender = generateKeyPairSync("ed25519");
const receiver = generateKeyPairSync("ed25519");
const senderIdentity = {
  node_id: "kratt-node", key_id: "kratt-signing-key", status: "ACTIVE",
  public_key: sender.publicKey, valid_from: "2026-01-01T00:00:00.000Z"
};
const receiverIdentity = {
  node_id: "steel-node", key_id: "steel-signing-key", status: "ACTIVE",
  public_key: receiver.publicKey, valid_from: "2026-01-01T00:00:00.000Z"
};

function makeNegotiationRequest(overrides = {}) {
  const request = {
    protocol: FABRIC_NEGOTIATION_PROTOCOL,
    negotiation_id: "negotiation-001",
    sender_node: "kratt-node",
    receiver_node: "steel-node",
    schema_id: "3xt-fabric-event",
    offered_versions: [
      { version: "1.0.0", schema_digest: HASH_A },
      { version: "2.0.0", schema_digest: HASH_B }
    ],
    minimum_version: "1.0.0",
    policy_revision: "receiver-policy-7",
    issued_at: "2026-11-26T16:59:00.000Z",
    expires_at: "2026-11-26T17:04:00.000Z",
    key_id: senderIdentity.key_id,
    content_digest: "",
    signature: "",
    ...overrides
  };
  request.content_digest = fabricSchemaNegotiationRequestDigest(request);
  request.signature = sign(null, Buffer.from(fabricSchemaNegotiationRequestSigningInput(request)), sender.privateKey).toString("base64");
  return request;
}

function makeAcknowledgement(overrides = {}) {
  const ack = {
    protocol: FABRIC_RECEIVER_ACK_PROTOCOL,
    ack_id: "ack-001",
    event_id: "event-001",
    source_node: "kratt-node",
    receiver_node: "steel-node",
    source_sequence: 41,
    event_digest: HASH_A,
    delivery_attempt: 2,
    result: "ACCEPTED",
    policy_revision: "receiver-policy-7",
    issued_at: "2026-11-26T16:59:30.000Z",
    key_id: receiverIdentity.key_id,
    content_digest: "",
    signature: "",
    ...overrides
  };
  ack.content_digest = fabricReceiverAcknowledgementDigest(ack);
  ack.signature = sign(null, Buffer.from(fabricReceiverAcknowledgementSigningInput(ack)), receiver.privateKey).toString("base64");
  return ack;
}

function negotiationDependencies(overrides = {}) {
  return {
    localNodeId: "steel-node",
    resolveTrustedKey: async (nodeId, keyId) => nodeId === "kratt-node" && keyId === senderIdentity.key_id ? senderIdentity : null,
    resolveSchemaPolicy: async () => ({
      status: "ACTIVE",
      revision: "receiver-policy-7",
      minimum_version: "1.0.0",
      supported_versions: [
        { version: "1.0.0", schema_digest: HASH_A },
        { version: "2.0.0", schema_digest: HASH_B }
      ]
    }),
    resolveSigningIdentity: async () => ({ ...receiverIdentity }),
    sign: async ({ message }) => sign(null, Buffer.from(message), receiver.privateKey).toString("base64"),
    now: () => NOW,
    ...overrides
  };
}

test("negotiates the highest exact schema digest in the active receiver policy", async () => {
  const result = await negotiateFabricSchema(makeNegotiationRequest(), negotiationDependencies());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.protocol, FABRIC_NEGOTIATION_RESPONSE_PROTOCOL);
  assert.equal(result.value.status, "SUPPORTED");
  assert.equal(result.value.selected_version, "2.0.0");
  assert.equal(result.value.schema_digest, HASH_B);
  assert.equal(result.value.policy_revision, "receiver-policy-7");
  assert.equal(result.value.request_digest, makeNegotiationRequest().content_digest);
  assert.equal(validateFabricSchemaNegotiationResponse(result.value).ok, true);
  assert.equal(verify(null, Buffer.from(fabricSchemaNegotiationResponseSigningInput(result.value)), receiver.publicKey,
    Buffer.from(result.value.signature, "base64")), true);
});

test("sender authenticates the receiver's signed negotiation response and request binding", async () => {
  const request = makeNegotiationRequest();
  const response = await negotiateFabricSchema(request, negotiationDependencies());
  assert.equal(response.ok, true, JSON.stringify(response));
  const authenticated = await authenticateFabricSchemaNegotiationResponse(response.value, {
    request,
    expectedReceiverNode: "steel-node",
    expectedSenderNode: "kratt-node",
    expectedNegotiationId: request.negotiation_id,
    expectedRequestDigest: request.content_digest,
    resolveTrustedKey: async (nodeId, keyId) =>
      nodeId === "steel-node" && keyId === receiverIdentity.key_id ? receiverIdentity : null,
    now: () => NOW
  });
  assert.equal(authenticated.ok, true, JSON.stringify(authenticated));
  assert.equal(authenticated.value.response.selected_version, "2.0.0");

  const wrongBinding = await authenticateFabricSchemaNegotiationResponse(response.value, {
    request,
    expectedReceiverNode: "steel-node",
    expectedSenderNode: "kratt-node",
    expectedNegotiationId: request.negotiation_id,
    expectedRequestDigest: HASH_B,
    resolveTrustedKey: async () => receiverIdentity,
    now: () => NOW
  });
  assert.equal(wrongBinding.code, "NEGOTIATION_RESPONSE_REQUEST_BINDING_MISMATCH");

  const untrusted = await authenticateFabricSchemaNegotiationResponse(response.value, {
    request,
    expectedReceiverNode: "steel-node",
    expectedSenderNode: "kratt-node",
    expectedNegotiationId: request.negotiation_id,
    expectedRequestDigest: request.content_digest,
    resolveTrustedKey: async () => null,
    now: () => NOW
  });
  assert.equal(untrusted.code, "NEGOTIATION_RESPONSE_ACK_KEY_UNTRUSTED");
});

test("sender rejects a validly signed receiver response below the offered minimum version", async () => {
  const request = makeNegotiationRequest({ minimum_version: "2.0.0" });
  const negotiated = await negotiateFabricSchema(request, negotiationDependencies());
  assert.equal(negotiated.ok, true, JSON.stringify(negotiated));
  assert.equal(negotiated.value.selected_version, "2.0.0");

  const downgrade = {
    ...negotiated.value,
    selected_version: "1.0.0",
    schema_digest: HASH_A,
    content_digest: "",
    signature: ""
  };
  downgrade.content_digest = fabricSchemaNegotiationResponseDigest(downgrade);
  downgrade.signature = sign(null, Buffer.from(fabricSchemaNegotiationResponseSigningInput(downgrade)), receiver.privateKey).toString("base64");
  assert.equal(verify(null, Buffer.from(fabricSchemaNegotiationResponseSigningInput(downgrade)),
    receiver.publicKey, Buffer.from(downgrade.signature, "base64")), true);

  const rejected = await authenticateFabricSchemaNegotiationResponse(downgrade, {
    request,
    expectedReceiverNode: "steel-node",
    expectedSenderNode: "kratt-node",
    expectedNegotiationId: request.negotiation_id,
    expectedRequestDigest: request.content_digest,
    resolveTrustedKey: async () => receiverIdentity,
    now: () => NOW
  });
  assert.equal(rejected.code, "NEGOTIATION_RESPONSE_VERSION_DOWNGRADE");
});

test("does not downgrade below the sender floor or the receiver policy floor", async () => {
  const request = makeNegotiationRequest({
    offered_versions: [{ version: "1.0.0", schema_digest: HASH_A }],
    minimum_version: "2.0.0"
  });
  request.content_digest = fabricSchemaNegotiationRequestDigest(request);
  request.signature = sign(null, Buffer.from(fabricSchemaNegotiationRequestSigningInput(request)), sender.privateKey).toString("base64");
  const result = await negotiateFabricSchema(request, negotiationDependencies());
  assert.equal(result.ok, true);
  assert.equal(result.value.status, "UNSUPPORTED");
  assert.equal(result.value.selected_version, null);
  assert.equal(result.value.reason, "NO_COMMON_ALLOWED_VERSION");
});

test("returns explicit UNKNOWN for an unregistered schema and UNSUPPORTED for a stale policy revision", async () => {
  const unknown = await negotiateFabricSchema(makeNegotiationRequest(), negotiationDependencies({
    resolveSchemaPolicy: async () => null
  }));
  assert.equal(unknown.ok, true);
  assert.equal(unknown.value.status, "UNKNOWN");
  assert.equal(unknown.value.reason, "SCHEMA_UNKNOWN");

  const stale = await negotiateFabricSchema(makeNegotiationRequest({ policy_revision: "receiver-policy-old" }), negotiationDependencies());
  // The signed request remains authentic; the current receiver policy decides its status.
  assert.equal(stale.ok, true);
  assert.equal(stale.value.status, "UNSUPPORTED");
  assert.equal(stale.value.reason, "POLICY_REVISION_MISMATCH");
});

test("rejects tampered negotiation digest, wrong receiver, untrusted sender and invalid signature", async () => {
  const tampered = makeNegotiationRequest();
  tampered.schema_id = "other-schema";
  assert.equal((await negotiateFabricSchema(tampered, negotiationDependencies())).code, "NEGOTIATION_DIGEST_MISMATCH");

  const wrongTarget = await negotiateFabricSchema(makeNegotiationRequest(), negotiationDependencies({ localNodeId: "other-node" }));
  assert.equal(wrongTarget.code, "NEGOTIATION_WRONG_RECEIVER");

  const untrusted = await negotiateFabricSchema(makeNegotiationRequest(), negotiationDependencies({
    resolveTrustedKey: async () => null
  }));
  assert.equal(untrusted.code, "NEGOTIATION_ACK_KEY_UNTRUSTED");

  const invalidSignature = makeNegotiationRequest();
  invalidSignature.signature = Buffer.alloc(64).toString("base64");
  const invalid = await negotiateFabricSchema(invalidSignature, negotiationDependencies());
  assert.equal(invalid.code, "NEGOTIATION_ACK_SIGNATURE_INVALID");
});

test("receiver ACK validates its closed envelope and Ed25519 signature", async () => {
  const ack = makeAcknowledgement();
  const result = await authenticateFabricReceiverAcknowledgement(ack, {
    expectedReceiverNode: "steel-node",
    expectedPolicyRevision: "receiver-policy-7",
    resolveTrustedKey: async (nodeId, keyId) => nodeId === "steel-node" && keyId === receiverIdentity.key_id ? receiverIdentity : null,
    now: () => NOW
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.acknowledgement.result, "ACCEPTED");
  assert.equal(validateFabricReceiverAcknowledgement(ack).ok, true);
});

test("receiver ACK rejects digest tampering, wrong receiver, stale policy and untrusted/revoked keys", async () => {
  const ack = makeAcknowledgement();
  const tampered = { ...ack, event_digest: HASH_B };
  assert.equal(validateFabricReceiverAcknowledgement(tampered).code, "ACK_DIGEST_MISMATCH");

  const wrongReceiver = await authenticateFabricReceiverAcknowledgement(ack, {
    expectedReceiverNode: "wrong-node", expectedPolicyRevision: "receiver-policy-7",
    resolveTrustedKey: async () => receiverIdentity, now: () => NOW
  });
  assert.equal(wrongReceiver.code, "ACK_WRONG_RECEIVER");

  const stalePolicy = await authenticateFabricReceiverAcknowledgement(ack, {
    expectedReceiverNode: "steel-node", expectedPolicyRevision: "receiver-policy-8",
    resolveTrustedKey: async () => receiverIdentity, now: () => NOW
  });
  assert.equal(stalePolicy.code, "ACK_POLICY_REVISION_MISMATCH");

  const revoked = await authenticateFabricReceiverAcknowledgement(ack, {
    expectedReceiverNode: "steel-node", expectedPolicyRevision: "receiver-policy-7",
    resolveTrustedKey: async () => ({ ...receiverIdentity, status: "REVOKED" }), now: () => NOW
  });
  assert.equal(revoked.code, "ACK_KEY_UNTRUSTED");

  const signatureTamper = { ...ack, signature: Buffer.alloc(64).toString("base64") };
  const invalid = await authenticateFabricReceiverAcknowledgement(signatureTamper, {
    expectedReceiverNode: "steel-node", expectedPolicyRevision: "receiver-policy-7",
    resolveTrustedKey: async () => receiverIdentity, now: () => NOW
  });
  assert.equal(invalid.code, "ACK_SIGNATURE_INVALID");
});

test("UNKNOWN/REJECTED outcomes are passed to reconciliation and never treated as successful delivery", async () => {
  for (const resultCode of ["UNKNOWN", "REJECTED"]) {
    const ack = makeAcknowledgement({ ack_id: "ack-" + resultCode.toLowerCase(), result: resultCode });
    let storeCalls = 0;
    const result = await processFabricReceiverAcknowledgement({
      acknowledgement: ack, expectedReceiverNode: "steel-node", expectedPolicyRevision: "receiver-policy-7",
      resolveTrustedKey: async () => receiverIdentity, outboxId: "outbox-001", leaseToken: "lease-token-123456",
      now: () => NOW,
      acknowledgementStore: { async applyReceiverAcknowledgement(input) {
        storeCalls++;
        assert.equal(input.acknowledgement.result, resultCode);
        return { ok: true, status: resultCode, outbox_status: "RECONCILE", reconciliation_required: true };
      } }
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.outbox_status, "RECONCILE");
    assert.equal(storeCalls, 1);
  }
});

test("rejects structurally tampered ACKs before storage and delegates event binding to PostgreSQL", async () => {
  const ack = makeAcknowledgement();
  let calls = 0;
  const malformed = { ...ack, event_id: "forged-event" };
  const rejectedBeforeStore = await processFabricReceiverAcknowledgement({
    acknowledgement: malformed, expectedReceiverNode: "steel-node", expectedPolicyRevision: "receiver-policy-7",
    resolveTrustedKey: async () => receiverIdentity, outboxId: "outbox-001", leaseToken: "lease-token-123456",
    now: () => NOW,
    acknowledgementStore: { async applyReceiverAcknowledgement() { calls++; return { ok: true }; } }
  });
  assert.equal(rejectedBeforeStore.code, "ACK_DIGEST_MISMATCH");
  assert.equal(calls, 0);

  const signedWrongEvent = { ...ack, ack_id: "ack-wrong-event", event_id: "forged-event", content_digest: "", signature: "" };
  signedWrongEvent.content_digest = fabricReceiverAcknowledgementDigest(signedWrongEvent);
  signedWrongEvent.signature = sign(null, Buffer.from(fabricReceiverAcknowledgementSigningInput(signedWrongEvent)), receiver.privateKey).toString("base64");
  const bindingRejected = await processFabricReceiverAcknowledgement({
    acknowledgement: signedWrongEvent, expectedReceiverNode: "steel-node", expectedPolicyRevision: "receiver-policy-7",
    resolveTrustedKey: async () => receiverIdentity, outboxId: "outbox-001", leaseToken: "lease-token-123456",
    now: () => NOW,
    acknowledgementStore: { async applyReceiverAcknowledgement() { calls++; return { ok: false, reason: "ACK_EVENT_BINDING_MISMATCH" }; } }
  });
  assert.equal(bindingRejected.code, "ACK_EVENT_BINDING_MISMATCH");
  assert.equal(calls, 1);
});

test("ACK without a negotiated policy revision fails closed", async () => {
  const result = await authenticateFabricReceiverAcknowledgement(makeAcknowledgement(), {
    expectedReceiverNode: "steel-node", resolveTrustedKey: async () => receiverIdentity, now: () => NOW
  });
  assert.equal(result.code, "ACK_POLICY_REVISION_MISMATCH");
});

test("nested negotiation and acknowledgement data snapshots reject getters and proxies without invoking them", () => {
  let getterCalls = 0;
  const request = makeNegotiationRequest();
  Object.defineProperty(request.offered_versions[0], "schema_digest", {
    enumerable: true,
    get() { getterCalls++; throw new Error("nested getter must not execute"); }
  });
  assert.equal(validateFabricSchemaNegotiationRequest(request).ok, false);
  assert.equal(getterCalls, 0);

  const proxiedVersions = makeNegotiationRequest();
  proxiedVersions.offered_versions = new Proxy(proxiedVersions.offered_versions, {
    get() { throw new Error("nested proxy trap must not execute"); }
  });
  assert.equal(validateFabricSchemaNegotiationRequest(proxiedVersions).ok, false);

  const acknowledgement = makeAcknowledgement();
  Object.defineProperty(acknowledgement, "event_digest", {
    enumerable: true,
    get() { getterCalls++; throw new Error("ACK getter must not execute"); }
  });
  assert.equal(validateFabricReceiverAcknowledgement(acknowledgement).ok, false);
  assert.equal(getterCalls, 0);
});
