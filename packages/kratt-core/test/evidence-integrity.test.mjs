import test from "node:test";
import assert from "node:assert/strict";
import {
  attachEvidenceCardDigest,
  canonicalizeEvidencePayload,
  computeEvidenceCardDigest,
  verifyEvidenceCardDigest,
} from "../src/evidence-integrity.mjs";

const sample = () => ({
  cardId: "card-1",
  schemaVersion: "kratt-evidence/v1",
  claim: { subjectId: "repo-file:abc123", predicate: "contains", objectValue: "policy.mjs" },
  source: { url: "https://example.test/source", observedAt: "2026-11-10T10:00:00.000Z" },
  stance: "supports",
  excerpt: "The source contains the stated policy file.",
});

test("canonical serialization is independent of object insertion order", () => {
  const left = { a: 1, b: { y: true, x: "value" } };
  const right = { b: { x: "value", y: true }, a: 1 };
  assert.equal(canonicalizeEvidencePayload(left), canonicalizeEvidencePayload(right));
  assert.equal(computeEvidenceCardDigest(left), computeEvidenceCardDigest(right));
});

test("attach and verify produces an intact immutable-digest card", () => {
  const card = attachEvidenceCardDigest(sample());
  assert.match(card.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyEvidenceCardDigest(card).ok, true);
  assert.equal(Object.getOwnPropertyDescriptor(card, "contentDigest").writable, false);
});

test("any integrity-relevant field mutation is detected", () => {
  const card = attachEvidenceCardDigest(sample());
  const altered = { ...card, excerpt: "A different excerpt." };
  assert.deepEqual(verifyEvidenceCardDigest(altered), {
    ok: false,
    reason: "EVIDENCE_CARD_DIGEST_MISMATCH",
  });
});

test("nested subject identifiers containing colons remain normal data", () => {
  const card = attachEvidenceCardDigest(sample());
  assert.equal(card.claim.subjectId, "repo-file:abc123");
  assert.equal(verifyEvidenceCardDigest(card).ok, true);
});

test("missing or malformed digest is rejected", () => {
  assert.equal(verifyEvidenceCardDigest(sample()).reason, "EVIDENCE_CARD_DIGEST_MISSING_OR_INVALID");
  assert.equal(verifyEvidenceCardDigest({ ...sample(), contentDigest: "verified" }).ok, false);
});

test("accessors are rejected without executing them", () => {
  let called = false;
  const unsafe = {};
  Object.defineProperty(unsafe, "secret", {
    enumerable: true,
    get() { called = true; return "not safe"; },
  });
  assert.throws(() => canonicalizeEvidencePayload(unsafe), /OBJECT_FIELD_INVALID/);
  assert.equal(called, false);
});

test("non-finite values, unsupported values, sparse arrays and cycles are rejected", () => {
  assert.throws(() => canonicalizeEvidencePayload({ value: Number.NaN }), /NON_FINITE_NUMBER/);
  assert.throws(() => canonicalizeEvidencePayload({ value: undefined }), /UNSUPPORTED_VALUE/);
  assert.throws(() => canonicalizeEvidencePayload({ value: [,,] }), /ARRAY_ITEM_INVALID/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeEvidencePayload(cyclic), /CIRCULAR_VALUE/);
});

test("caller cannot overwrite a previously attached digest", () => {
  const card = attachEvidenceCardDigest(sample());
  assert.throws(() => attachEvidenceCardDigest(card), /DIGEST_ALREADY_PRESENT/);
});
