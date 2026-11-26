import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  FABRIC_PROTOCOL, canonicalizeJcs as steelCanonicalizeJcs, eventContentDigest as steelEventContentDigest,
  validateFabricEvent as steelValidateFabricEvent, verifyContentDigest as steelVerifyContentDigest,
  authenticateEvent as steelAuthenticateEvent
} from "./fixtures/steel/fabric-v1.ts";
import {
  FABRIC_WIRE_PROTOCOL, canonicalizeFabricJcs, fabricEventContentDigest, fabricSigningInput,
  validateSteelFabricEventV1, authenticateSteelFabricEventV1
} from "../src/fabric-interoperability.mjs";

const STEEL_SOURCE = Object.freeze({
  repository: "3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP-",
  commit: "1978fa37d5df7bfa6cb2a3ba64480307492893d5",
  path: "factory/protocol/fabric-v1.ts",
  blobSha: "79f08585da61a390cd59cbe44f069e8a821481da"
});
const NOW = Date.parse("2026-11-26T12:00:00.000Z");

function makeBody(sourceNode, sourceRevision, eventId) {
  return {
    protocol: "3XT-FABRIC/1", event_id: eventId, event_type: "factory.task.accepted",
    source_node: sourceNode, destination_node: sourceNode === "steel-node" ? "kratt-node" : "steel-node",
    source_revision: sourceRevision, correlation_id: "cross-repo-correlation-01",
    parent_event_id: null, sequence: 1, issued_at: "2026-11-26T11:59:00.000Z",
    expires_at: "2026-11-26T12:04:00.000Z", scope: ["repository.read", "evidence.read"],
    payload_reference: null, evidence_references: ["evidence:cross-repo-001"],
    key_id: sourceNode + "-key-01",
    payload: { action: "accepted", nested: { z: 1, a: "stable" }, task_id: "cross-repo-task-01" },
    content_digest: "0".repeat(64), signature: ""
  };
}
function signedBySteel(body, privateKey) {
  const event = { ...body, content_digest: steelEventContentDigest(body), signature: "" };
  const input = Buffer.from(FABRIC_PROTOCOL + "\n" + event.source_node + "\n" + event.key_id + "\n" + event.content_digest, "utf8");
  event.signature = sign(null, input, privateKey).toString("base64");
  return event;
}
function signedByKratt(body, privateKey) {
  const event = { ...body, content_digest: fabricEventContentDigest(body), signature: "" };
  event.signature = sign(null, Buffer.from(fabricSigningInput(event), "utf8"), privateKey).toString("base64");
  return event;
}

test("STEEL contract source is pinned to the observed repository commit and blob", () => {
  assert.equal(STEEL_SOURCE.commit, "1978fa37d5df7bfa6cb2a3ba64480307492893d5");
  assert.equal(STEEL_SOURCE.blobSha, "79f08585da61a390cd59cbe44f069e8a821481da");
  assert.equal(FABRIC_PROTOCOL, FABRIC_WIRE_PROTOCOL);
});

test("STEEL-produced events validate and authenticate in both source-pinned STEEL and KRATT", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const event = signedBySteel(makeBody("steel-node", STEEL_SOURCE.commit, "steel-to-kratt-001"), privateKey);
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(steelValidateFabricEvent(event).ok, true);
  assert.equal(steelVerifyContentDigest(event).ok, true);
  assert.equal(validateSteelFabricEventV1(event).ok, true);
  assert.equal(steelCanonicalizeJcs(event), canonicalizeFabricJcs(event));
  assert.equal(steelEventContentDigest(event), fabricEventContentDigest(event));
  const [a, b] = await Promise.all([
    steelAuthenticateEvent(event, async () => ({ source_node: "steel-node", key_id: "steel-node-key-01", public_key: publicKey })),
    authenticateSteelFabricEventV1(event, { resolveTrustedKey: async () => ({
      source_node: "steel-node", key_id: "steel-node-key-01", public_key: pem, status: "ACTIVE",
      valid_from: "2026-01-01T00:00:00.000Z", sign_until: "2027-01-01T00:00:00.000Z"
    }), now: () => NOW })
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
});

test("KRATT-produced events validate and authenticate in the pinned STEEL implementation", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const event = signedByKratt(makeBody("kratt-node", "dabb19d26cc20b23f6a25f5360a2b474acc11447", "kratt-to-steel-001"), privateKey);
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(validateSteelFabricEventV1(event).ok, true);
  assert.equal(steelValidateFabricEvent(event).ok, true);
  assert.equal(steelEventContentDigest(event), fabricEventContentDigest(event));
  assert.equal(steelCanonicalizeJcs(event), canonicalizeFabricJcs(event));
  assert.equal((await steelAuthenticateEvent(event, async () => ({
    source_node: "kratt-node", key_id: "kratt-node-key-01", public_key: publicKey
  }))).ok, true);
  assert.equal((await authenticateSteelFabricEventV1(event, { resolveTrustedKey: async () => ({
    source_node: "kratt-node", key_id: "kratt-node-key-01", public_key: pem, status: "ACTIVE",
    valid_from: "2026-01-01T00:00:00.000Z", sign_until: "2027-01-01T00:00:00.000Z"
  }), now: () => NOW })).ok, true);
});

test("STEEL and KRATT reject digest tampering, unknown fields and invalid signatures", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const event = signedBySteel(makeBody("steel-node", STEEL_SOURCE.commit, "tamper-check-001"), privateKey);
  const changed = { ...event, payload: { ...event.payload, action: "forged" } };
  assert.equal(steelValidateFabricEvent(changed).ok, true, "STEEL separates schema validation from digest verification");
  assert.equal(steelVerifyContentDigest(changed).ok, false, "STEEL digest verification rejects tampering");
  assert.equal(validateSteelFabricEventV1(changed).ok, false, "KRATT validates schema and digest together");
  const extra = { ...event, uncontracted: true };
  assert.equal(steelValidateFabricEvent(extra).ok, false);
  assert.equal(validateSteelFabricEventV1(extra).ok, false);
  const bad = { ...event, signature: Buffer.alloc(64, 7).toString("base64") };
  assert.equal((await steelAuthenticateEvent(bad, async () => ({
    source_node: "steel-node", key_id: "steel-node-key-01", public_key: publicKey
  }))).ok, false);
  assert.equal((await authenticateSteelFabricEventV1(bad, { resolveTrustedKey: async () => ({
    source_node: "steel-node", key_id: "steel-node-key-01",
    public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    status: "ACTIVE", valid_from: "2026-01-01T00:00:00.000Z", sign_until: "2027-01-01T00:00:00.000Z"
  }), now: () => NOW })).ok, false);
});
