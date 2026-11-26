import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  FABRIC_WIRE_PROTOCOL, FABRIC_CANONICAL_SCHEMA, authenticateSteelFabricEventV1,
  authorizeSteelFabricEventV1, fabricEventContentDigest, fabricSigningInput,
  parseSteelFabricEventV1, receiveSteelFabricEventV1, toCanonicalFabricEventV2,
  validateSteelFabricEventV1
} from "../src/fabric-interoperability.mjs";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const key = { source_node: "steel-node", key_id: "steel-key-1", public_key: publicKey, status: "ACTIVE", valid_from: "2026-01-01T00:00:00.000Z" };

function makeEvent(overrides = {}) {
  const event = {
    protocol: FABRIC_WIRE_PROTOCOL, event_id: "steel-evt-001", event_type: "factory.task.accepted",
    source_node: "steel-node", destination_node: "kratt-node", source_revision: "a".repeat(40),
    correlation_id: "corr-001", parent_event_id: null, sequence: 1,
    issued_at: "2026-11-26T11:59:00.000Z", expires_at: "2026-11-26T12:04:00.000Z",
    scope: ["repository.read"], payload_reference: null, evidence_references: ["evidence:001"],
    key_id: "steel-key-1", payload: { task_id: "task-001", status: "accepted" },
    content_digest: "0".repeat(64), signature: "", ...overrides
  };
  event.content_digest = fabricEventContentDigest(event);
  event.signature = sign(null, Buffer.from(fabricSigningInput(event), "utf8"), privateKey).toString("base64");
  return event;
}

const trustedKeyResolver = async (sourceNode, keyId) =>
  sourceNode === key.source_node && keyId === key.key_id ? key : null;
const policy = {
  source_node: "steel-node", key_id: "steel-key-1", status: "ACTIVE",
  revision: "policy-2026-11-26", destinations: ["kratt-node"],
  allowed_event_types: ["factory.task.accepted"], allowed_scope: ["repository.read"]
};

function mockPool({ lastSequence = 0, parentExists = true, existingRows = [] } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT event_id, source_node, source_sequence, content_digest")) return { rowCount: existingRows.length, rows: existingRows };
      if (normalized.startsWith("SELECT last_sequence, last_event_id")) return { rowCount: 1, rows: [{ last_sequence: lastSequence, last_event_id: null }] };
      if (normalized.startsWith("SELECT event_id FROM kratt_fabric_event_inbox WHERE event_id")) return { rowCount: parentExists ? 1 : 0, rows: parentExists ? [{ event_id: params[0] }] : [] };
      if (normalized.includes("INSERT INTO kratt_fabric_event_inbox")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() { queries.push({ sql: "RELEASE", params: [] }); }
  };
  return { pool: { connect: async () => client }, queries };
}

test("accepts a valid 3XT-FABRIC/1 event as a detached immutable snapshot", () => {
  const input = makeEvent();
  const result = validateSteelFabricEventV1(input);
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.payload), true);
  input.payload.status = "tampered";
  assert.equal(result.value.payload.status, "accepted");
});

test("rejects primitive and null wire values without throwing", () => {
  for (const value of [null, undefined, "event", 7, true, []]) {
    assert.equal(validateSteelFabricEventV1(value).ok, false);
  }
});

test("rejects missing, extra, incompatible and malformed wire fields", () => {
  const event = makeEvent();
  const { event_id: _eventId, ...missing } = event;
  assert.equal(validateSteelFabricEventV1(missing).code, "EVENT_SHAPE_INVALID");
  assert.equal(validateSteelFabricEventV1({ ...event, extra: true }).code, "EVENT_SHAPE_INVALID");
  assert.equal(validateSteelFabricEventV1({ ...event, protocol: "3XT-FABRIC/2" }).code, "SCHEMA_UNSUPPORTED");
  assert.equal(validateSteelFabricEventV1({ ...event, sequence: 0 }).ok, false);
  assert.equal(validateSteelFabricEventV1({ ...event, issued_at: "2026-02-30T12:00:00Z" }).ok, false);
});

test("rejects getter-backed and proxy-backed inputs without invoking accessors", () => {
  let getterCalls = 0;
  const accessor = makeEvent();
  Object.defineProperty(accessor.payload, "danger", { enumerable: true, get() { getterCalls += 1; throw new Error("must not run"); } });
  assert.equal(validateSteelFabricEventV1(accessor).ok, false);
  assert.equal(getterCalls, 0);
  const proxied = new Proxy(makeEvent(), { ownKeys() { throw new Error("proxy trap"); } });
  assert.equal(validateSteelFabricEventV1(proxied).ok, false);
});

test("rejects cycles, sparse arrays, unsafe keys and invalid Unicode", () => {
  const cyclic = {}; cyclic.self = cyclic;
  const cyclicEvent = makeEvent(); cyclicEvent.payload = cyclic;
  assert.equal(validateSteelFabricEventV1(cyclicEvent).ok, false);
  const sparse = []; sparse.length = 1;
  const sparseEvent = makeEvent(); sparseEvent.payload = { items: sparse };
  assert.equal(validateSteelFabricEventV1(sparseEvent).ok, false);
  const unsafeEvent = makeEvent(); unsafeEvent.payload = JSON.parse('{"constructor":{"prototype":{"admin":true}}}');
  assert.equal(validateSteelFabricEventV1(unsafeEvent).ok, false);
  const unicodeEvent = makeEvent(); unicodeEvent.payload = { bad: "\ud800" };
  assert.equal(validateSteelFabricEventV1(unicodeEvent).ok, false);
});

test("detects a changed payload even when the envelope shape remains valid", () => {
  const event = makeEvent();
  event.payload.status = "changed";
  assert.equal(validateSteelFabricEventV1(event).code, "DIGEST_MISMATCH");
});

test("parse enforces the byte ceiling, UTF-8 and exact JSON validation", () => {
  assert.equal(parseSteelFabricEventV1("{").code, "EVENT_PARSE_FAILED");
  assert.equal(parseSteelFabricEventV1(" ".repeat(256 * 1024 + 1)).code, "EVENT_TOO_LARGE");
  assert.equal(parseSteelFabricEventV1(Buffer.from([0xff, 0xfe])).code, "EVENT_PARSE_FAILED");
  assert.equal(parseSteelFabricEventV1(JSON.stringify(makeEvent())).ok, true);
});

test("Ed25519 verification binds source node, key id and digest", async () => {
  const event = validateSteelFabricEventV1(makeEvent()).value;
  assert.equal((await authenticateSteelFabricEventV1(event, { resolveTrustedKey: trustedKeyResolver, now: () => NOW })).ok, true);
  const badSignature = Object.freeze({ ...event, signature: Buffer.alloc(64).toString("base64") });
  assert.equal((await authenticateSteelFabricEventV1(badSignature, { resolveTrustedKey: trustedKeyResolver, now: () => NOW })).code, "SIGNATURE_INVALID");
  assert.equal((await authenticateSteelFabricEventV1(event, { resolveTrustedKey: async () => null, now: () => NOW })).code, "KEY_UNAVAILABLE");
});

test("key lifecycle accepts active and retired verification-only keys but rejects revoked keys", async () => {
  const event = validateSteelFabricEventV1(makeEvent()).value;
  const retired = { ...key, status: "VERIFY_ONLY", retired_at: "2026-11-26T12:01:00.000Z", verify_until: "2027-01-01T00:00:00.000Z" };
  assert.equal((await authenticateSteelFabricEventV1(event, { resolveTrustedKey: async () => retired, now: () => NOW })).ok, true);
  const revoked = { ...key, status: "REVOKED" };
  assert.equal((await authenticateSteelFabricEventV1(event, { resolveTrustedKey: async () => revoked, now: () => NOW })).code, "KEY_REVOKED");
  const retiredBeforeIssue = { ...key, status: "VERIFY_ONLY", retired_at: "2026-11-26T11:58:00.000Z" };
  assert.equal((await authenticateSteelFabricEventV1(event, { resolveTrustedKey: async () => retiredBeforeIssue, now: () => NOW })).code, "KEY_RETIRED_FOR_EVENT");
});

test("canonical mapping preserves all wire semantics and marks absent agent/component as null", () => {
  const event = validateSteelFabricEventV1(makeEvent()).value;
  const mapped = toCanonicalFabricEventV2(event, { source_node: event.source_node, key_id: event.key_id });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.value.schema_version, FABRIC_CANONICAL_SCHEMA);
  assert.equal(mapped.value.provenance.source_agent_id, null);
  assert.equal(mapped.value.provenance.source_component, null);
  assert.equal(mapped.value.authorization_request.requested_scope[0], "repository.read");
  assert.equal(mapped.value.integrity.content_digest, event.content_digest);
  assert.equal(toCanonicalFabricEventV2(event, null).code, "AUTHENTICATED_IDENTITY_REQUIRED");
});

test("authorization scope is derived from server-owned policy, never inferred from payload", () => {
  const event = validateSteelFabricEventV1(makeEvent()).value;
  const identity = { source_node: event.source_node, key_id: event.key_id };
  assert.equal(authorizeSteelFabricEventV1(event, identity, policy).ok, true);
  assert.equal(authorizeSteelFabricEventV1(event, identity, { ...policy, allowed_scope: [] }).code, "SCOPE_NOT_AUTHORIZED");
  assert.equal(authorizeSteelFabricEventV1(event, identity, { ...policy, destinations: ["other-node"] }).code, "DESTINATION_NOT_AUTHORIZED");
  assert.equal(authorizeSteelFabricEventV1(event, identity, { ...policy, status: "DISABLED" }).code, "SOURCE_NOT_AUTHORIZED");
});

test("ingress persists inbox and source watermark before acknowledging", async () => {
  const { pool, queries } = mockPool();
  const handled = [];
  const result = await receiveSteelFabricEventV1(pool, JSON.stringify(makeEvent()), {
    localNodeId: "kratt-node", resolveTrustedKey: trustedKeyResolver, resolveNodePolicy: async () => policy,
    now: () => NOW, handler: async (canonical, tx) => { handled.push(canonical); assert.ok(tx.client); return "recorded"; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.duplicate, false);
  assert.equal(result.value.sequence_gap, false);
  assert.equal(handled[0].schema_version, FABRIC_CANONICAL_SCHEMA);
  assert.equal(queries[0].sql, "BEGIN");
  assert.ok(queries.some(query => query.sql.startsWith("UPDATE kratt_fabric_source_heads")));
  assert.equal(queries.at(-2).sql, "COMMIT");
});

test("ingress refuses wrong destination, missing parent and stale sequence", async () => {
  const deps = { localNodeId: "kratt-node", resolveTrustedKey: trustedKeyResolver, resolveNodePolicy: async () => policy, now: () => NOW, handler: async () => assert.fail("handler must not run") };
  const wrongDestination = mockPool();
  assert.equal((await receiveSteelFabricEventV1(wrongDestination.pool, JSON.stringify(makeEvent({ destination_node: "elsewhere" })), deps)).code, "DESTINATION_NOT_LOCAL");
  const missingParent = mockPool({ parentExists: false });
  const child = makeEvent({ event_id: "child-evt", sequence: 2, parent_event_id: "missing-parent" });
  assert.equal((await receiveSteelFabricEventV1(missingParent.pool, JSON.stringify(child), deps)).code, "CAUSAL_PARENT_MISSING");
  const stale = mockPool({ lastSequence: 5 });
  assert.equal((await receiveSteelFabricEventV1(stale.pool, JSON.stringify(makeEvent({ sequence: 5 })), deps)).code, "SEQUENCE_STALE");
});

test("ingress rejects policy scope escalation and expired messages before persistence", async () => {
  const noDb = { connect: async () => assert.fail("must not connect") };
  const deps = { localNodeId: "kratt-node", resolveTrustedKey: trustedKeyResolver, resolveNodePolicy: async () => ({ ...policy, allowed_scope: [] }), now: () => NOW, handler: async () => null };
  assert.equal((await receiveSteelFabricEventV1(noDb, JSON.stringify(makeEvent()), deps)).code, "SCOPE_NOT_AUTHORIZED");
  const expired = makeEvent({ expires_at: "2026-11-26T11:59:30.000Z" });
  const expiredDeps = { ...deps, resolveNodePolicy: async () => policy };
  assert.equal((await receiveSteelFabricEventV1(noDb, JSON.stringify(expired), expiredDeps)).code, "EVENT_EXPIRED");
});

test("ingress rolls back if handler fails and never acknowledges the event", async () => {
  const { pool, queries } = mockPool();
  const deps = { localNodeId: "kratt-node", resolveTrustedKey: trustedKeyResolver, resolveNodePolicy: async () => policy, now: () => NOW, handler: async () => { throw new Error("handler crash"); } };
  assert.equal((await receiveSteelFabricEventV1(pool, JSON.stringify(makeEvent()), deps)).code, "EVENT_HANDLER_FAILED");
  assert.ok(queries.some(query => query.sql === "ROLLBACK"));
  assert.equal(queries.some(query => query.sql === "COMMIT"), false);
});
