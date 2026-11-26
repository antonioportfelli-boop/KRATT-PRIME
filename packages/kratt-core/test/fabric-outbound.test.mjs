import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalTaskDigest } from "../src/policy.mjs";
import { FABRIC_WIRE_PROTOCOL, fabricSigningInput, validateSteelFabricEventV1 } from "../src/fabric-interoperability.mjs";
import { createSteelFabricOutboundAdapter } from "../src/fabric-outbound-adapter.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const principal = { id: "operator-01" };
const task = {
  schema_version: "kratt-prime/v0.1",
  task_id: "task-fabric-out-01",
  actor: principal.id,
  action: "repository.write",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
  constraints: { provider: "fabric", branch: "feature/wave3-test" },
  required_evidence: [],
  created_at: "2026-11-26T11:55:00.000Z",
  requested_authority: ["fabric.publish"],
  status: "PENDING"
};
const requestDigest = canonicalTaskDigest(task);
const digestHex = requestDigest.slice(7);
const idempotencyKey = `kratt:${task.task_id}:${digestHex}`;
const approval = {
  approval_id: "approval-fabric-001",
  task_id: task.task_id,
  actor: principal.id,
  provider: "fabric",
  operation: task.action,
  target: { ...task.target },
  request_digest: requestDigest,
  key_id: "approval-key-01",
  nonce: "approval-nonce-001",
  issued_at: "2026-11-26T11:59:00.000Z",
  expires_at: "2026-11-26T12:04:00.000Z",
  decision: "APPROVE",
  authority: "fabric.publish",
  signature: "verified-by-injected-approval-runtime"
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const policy = {
  status: "ACTIVE",
  source_node: "kratt-node",
  destination_node: "steel-node",
  revision: "outbound-policy-7",
  approval_provider: "fabric",
  approval_authority: "fabric.publish",
  allowed_event_types: ["factory.task.requested"],
  scope_by_event_type: { "factory.task.requested": ["repository.read", "evidence.read"] },
  max_ttl_ms: 300_000,
  key_id: "kratt-fabric-key-01"
};
const identity = {
  source_node: "kratt-node",
  key_id: "kratt-fabric-key-01",
  status: "ACTIVE",
  public_key: publicKey
};

function makeStore(overrides = {}) {
  const state = { sequenceCalls: [], reserveCalls: [], existing: null };
  const store = {
    async findOutboxByIdempotencyKey(key) {
      if (overrides.find) return overrides.find(key, state);
      if (state.existing) return { ok: true, found: true, status: "PENDING", attempts: 0, event: state.existing };
      return { ok: true, found: false };
    },
    async reserveFabricSequence(input) {
      state.sequenceCalls.push(input);
      return overrides.sequence ? overrides.sequence(input, state) : { ok: true, sequence: 41, duplicate: false };
    },
    async reserveAuthorizedIntent(input) {
      state.reserveCalls.push(input);
      if (overrides.reserve) return overrides.reserve(input, state);
      state.existing = input.fabricEvent;
      return { ok: true, outbox_id: "outbox-fabric-001", audit_sequence: 18 };
    }
  };
  return { store, state };
}

function makeAdapter(store, overrides = {}) {
  return createSteelFabricOutboundAdapter({
    outboxStore: store,
    sourceNode: "kratt-node",
    resolveSourceRevision: async () => "a".repeat(40),
    resolveOutboundPolicy: async () => policy,
    resolveSigningIdentity: async () => identity,
    sign: async ({ message }) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
    verifyApproval: async (artifact, binding) => artifact.signature === approval.signature &&
      binding.request_digest === requestDigest && binding.authority === "fabric.publish",
    resolvePayload: async () => ({ task_id: task.task_id, action: task.action, outcome: "requested" }),
    resolveEvidenceReferences: async () => ["evidence:trusted-001"],
    resolveCorrelationId: async () => "corr-fabric-out-001",
    resolveCausalParent: async () => null,
    resolvePayloadReference: async () => null,
    now: () => NOW,
    ...overrides
  });
}

test("publishes a server-composed, Ed25519-signed Fabric event into the outbox intent", async () => {
  const { store, state } = makeStore();
  const result = await makeAdapter(store).publish({ task, principal, approval, idempotencyKey, eventType: "factory.task.requested" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.queued, true);
  assert.equal(result.value.duplicate, false);
  assert.equal(result.value.sequence, 41);
  assert.equal(result.value.event.protocol, FABRIC_WIRE_PROTOCOL);
  assert.deepEqual(result.value.event.scope, ["repository.read", "evidence.read"]);
  assert.deepEqual(result.value.event.evidence_references, ["evidence:trusted-001"]);
  assert.equal(result.value.event.payload.task_id, task.task_id);
  assert.equal(verify(null, Buffer.from(fabricSigningInput(result.value.event)), publicKey, Buffer.from(result.value.event.signature, "base64")), true);
  assert.equal(state.sequenceCalls.length, 1);
  assert.equal(state.reserveCalls.length, 1);
  assert.equal(state.reserveCalls[0].provider, "fabric");
  assert.equal(state.reserveCalls[0].fabricEvent.event_id, result.value.event.event_id);
  assert.equal(state.reserveCalls[0].providerPayload.fabric_envelope.signature, result.value.event.signature);
});

test("does not accept caller-provided scope or payload; server resolvers define the envelope", async () => {
  const { store, state } = makeStore();
  const adapter = makeAdapter(store, {
    resolveOutboundPolicy: async () => ({ ...policy, scope_by_event_type: { "factory.task.requested": ["repository.read"] } }),
    resolvePayload: async () => ({ source: "server-owned" })
  });
  const result = await adapter.publish({
    task, principal, approval, idempotencyKey,
    eventType: "factory.task.requested",
    scope: ["admin.write"],
    payload: { admin: true }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.event.scope, ["repository.read"]);
  assert.equal(result.value.event.payload.source, "server-owned");
  assert.equal(state.sequenceCalls.length, 1);
});

test("rejects event types outside the server-owned policy before reserving a sequence", async () => {
  const { store, state } = makeStore();
  const result = await makeAdapter(store).publish({ task, principal, approval, idempotencyKey, eventType: "repository.delete" });
  assert.equal(result.code, "OUTBOUND_POLICY_DENIED");
  assert.equal(state.sequenceCalls.length, 0);
  assert.equal(state.reserveCalls.length, 0);
});

test("rejects approval mismatch, expired approval and wrong principal before outbox creation", async () => {
  const { store, state } = makeStore();
  const adapter = makeAdapter(store);
  const wrongApproval = { ...approval, request_digest: "sha256:" + "f".repeat(64) };
  assert.equal((await adapter.publish({ task, principal, approval: wrongApproval, idempotencyKey, eventType: "factory.task.requested" })).code, "APPROVAL_BINDING_MISMATCH");
  const expiredApproval = { ...approval, expires_at: "2026-11-26T11:59:59.000Z" };
  assert.equal((await adapter.publish({ task, principal, approval: expiredApproval, idempotencyKey, eventType: "factory.task.requested" })).code, "APPROVAL_TIME_INVALID");
  assert.equal((await adapter.publish({ task, principal: { id: "other-operator" }, approval, idempotencyKey, eventType: "factory.task.requested" })).code, "PRINCIPAL_MISMATCH");
  assert.equal(state.sequenceCalls.length, 0);
});

test("fails closed when signing identity and signature do not match", async () => {
  const { store, state } = makeStore();
  const wrongPair = generateKeyPairSync("ed25519");
  const adapter = makeAdapter(store, {
    sign: async ({ message }) => sign(null, Buffer.from(message), wrongPair.privateKey).toString("base64")
  });
  assert.equal((await adapter.publish({ task, principal, approval, idempotencyKey, eventType: "factory.task.requested" })).code, "OUTBOUND_SIGNATURE_KEY_MISMATCH");
  assert.equal(state.reserveCalls.length, 0);
});

test("same idempotency key returns the previously persisted signed event without allocating a new sequence", async () => {
  const { store, state } = makeStore();
  const first = await makeAdapter(store).publish({ task, principal, approval, idempotencyKey, eventType: "factory.task.requested" });
  assert.equal(first.ok, true);
  const again = await makeAdapter(store).publish({ task, principal, approval, idempotencyKey, eventType: "factory.task.requested" });
  assert.equal(again.ok, true);
  assert.equal(again.value.duplicate, true);
  assert.equal(again.value.event.event_id, first.value.event.event_id);
  assert.equal(again.value.event.content_digest, first.value.event.content_digest);
  assert.equal(state.sequenceCalls.length, 1);
  assert.equal(state.reserveCalls.length, 1);
});

test("database sequence reservation binds an idempotency key to one immutable request digest", async () => {
  const { store, state } = makeStore({
    sequence: async (input, state) => {
      if (state.sequenceCalls.length > 1 && state.sequenceCalls[0].requestDigest !== input.requestDigest) {
        return { ok: false, reason: "FABRIC_SEQUENCE_REQUEST_CONFLICT" };
      }
      return { ok: true, sequence: 7, duplicate: state.sequenceCalls.length > 1 };
    }
  });
  const first = await store.reserveFabricSequence({ sourceNode: "kratt-node", idempotencyKey, requestDigest: "a".repeat(64) });
  const same = await store.reserveFabricSequence({ sourceNode: "kratt-node", idempotencyKey, requestDigest: "a".repeat(64) });
  const conflict = await store.reserveFabricSequence({ sourceNode: "kratt-node", idempotencyKey, requestDigest: "b".repeat(64) });
  assert.equal(first.ok, true);
  assert.equal(same.ok, true);
  assert.equal(same.sequence, first.sequence);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "FABRIC_SEQUENCE_REQUEST_CONFLICT");
});
