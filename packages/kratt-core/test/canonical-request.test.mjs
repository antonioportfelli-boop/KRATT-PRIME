import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeRequest,
  digestCanonicalRequest,
  createRequestFingerprint,
} from "../src/canonical-request.mjs";

test("canonicalization sorts keys and normalizes negative zero", () => {
  const left = digestCanonicalRequest({ z: 1, nested: { b: 2, a: -0 } });
  const right = digestCanonicalRequest({ nested: { a: 0, b: 2 }, z: 1 });
  assert.equal(left.canonical.text, right.canonical.text);
  assert.equal(left.digest, right.digest);
});

test("rejects accessors without invoking them", () => {
  let called = false;
  const input = {};
  Object.defineProperty(input, "secret", { enumerable: true, get() { called = true; return "value"; } });
  assert.throws(() => canonicalizeRequest(input), /CANONICAL_OBJECT_ACCESSOR_OR_HIDDEN_FIELD/);
  assert.equal(called, false);
});

test("rejects sparse arrays and non-plain objects", () => {
  const sparse = [];
  sparse[2] = "x";
  assert.throws(() => canonicalizeRequest(sparse), /CANONICAL_ARRAY_SHAPE_INVALID/);
  assert.throws(() => canonicalizeRequest(new Date()), /CANONICAL_OBJECT_NOT_PLAIN/);
});

test("rejects cycles, dangerous keys, and oversized payloads", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeRequest(cyclic), /CANONICAL_CYCLE_DETECTED/);
  assert.throws(() => canonicalizeRequest(JSON.parse('{"__proto__":{"polluted":true}}')), /CANONICAL_UNSAFE_KEY/);
  assert.throws(() => canonicalizeRequest({ payload: "x".repeat(256) }, { maxBytes: 64 }), /CANONICAL_BYTE_LIMIT_EXCEEDED/);
});

test("request fingerprint is scoped to actor, target and policy version", () => {
  const base = { actor: "agent-1", action: "repo.read", target: { id: "repo-1" }, provider: "github", policyVersion: "policy-v1", payload: { path: "README.md" } };
  const one = createRequestFingerprint(base);
  const two = createRequestFingerprint({ ...base, policyVersion: "policy-v2" });
  const three = createRequestFingerprint({ ...base, actor: "agent-2" });
  assert.notEqual(one.digest, two.digest);
  assert.notEqual(one.digest, three.digest);
});

test("rejects non-finite numbers and unsupported values", () => {
  assert.throws(() => canonicalizeRequest({ n: Number.NaN }), /CANONICAL_NUMBER_NOT_FINITE/);
  assert.throws(() => canonicalizeRequest({ fn() {} }), /CANONICAL_TYPE_UNSUPPORTED/);
});
