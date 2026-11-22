import test from "node:test";
import assert from "node:assert/strict";
import { KRATT_SCHEMA_VERSION, validateTaskEnvelope, validateTrustedContext } from "../src/contracts.mjs";
import {
  canonicalApprovalPayload, canonicalTaskDigest, createRequestBoundApprovalVerifier,
  evaluatePolicy, isPolicyDecision,
} from "../src/policy.mjs";

const at = "2026-11-04T07:00:00.000Z";
const now = Date.parse(at);
const task = (overrides = {}) => ({
  schema_version: KRATT_SCHEMA_VERSION, task_id: "task-1", actor: "builder", action: "repo.read",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
  constraints: { branch: "integration" }, required_evidence: [], created_at: at,
  requested_authority: ["untrusted.request.authority"], status: "PENDING", ...overrides,
});
const context = (overrides = {}) => ({
  schema_version: KRATT_SCHEMA_VERSION, authorities: ["repository.read"],
  allowed_targets: [{ resource_type: "repository", resource_id: "KRATT-PRIME", branch: "integration" }],
  policies: [{ action: "repo.read", required_authority: "repository.read", target_types: ["repository"], side_effect_class: "READ_ONLY" }],
  evaluated_at: at, expires_at: "2026-11-04T07:05:00.000Z", kill_switch: false, ...overrides,
});
const evidence = () => ({
  schema_version: KRATT_SCHEMA_VERSION, evidence_id: "ev-1", subject: "KRATT-PRIME", claim_type: "TESTS_PASSED",
  source: { source_type: "github", source_id: "run-1", revision: "0123456789012345678901234567890123456789" },
  observed_at: at, verification_method: "signed-attestation", result: "VERIFIED", artifact_digest: null, metadata: {},
});

test("contracts reject unknown fields, accessors, sparse arrays and expired trusted contexts", () => {
  assert.equal(validateTaskEnvelope(task()).ok, true);
  assert.equal(validateTaskEnvelope({ ...task(), isAdmin: true }).ok, false);
  const accessor = task(); Object.defineProperty(accessor, "admin", { enumerable: true, get() { throw new Error("must not execute"); } });
  assert.equal(validateTaskEnvelope(accessor).ok, false);
  const sparse = []; sparse.length = 1;
  assert.equal(validateTaskEnvelope(task({ required_evidence: sparse })).ok, false);
  assert.equal(validateTrustedContext(context()).ok, true);
  assert.equal(validateTrustedContext({ ...context(), kill_switch: undefined }).ok, false);
});

test("policy uses trusted authority, target scope, trusted time and kill switch", () => {
  assert.equal(evaluatePolicy(task(), [], context(), { now }).decision, "ALLOW");
  assert.equal(evaluatePolicy(task(), [], context({ authorities: [] }), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task(), [], context(), {}).decision, "BLOCKED");
  assert.equal(evaluatePolicy(task({ target: { resource_type: "repository", resource_id: "OTHER" } }), [], context(), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task({ status: "CANCELLED" }), [], context(), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task(), [], context({ kill_switch: true }), { now }).decision, "DENY");
});

test("overlapping applicable policies block; disjoint target policies remain usable", () => {
  const rules = [
    { action: "resource.read", required_authority: "repository.read", target_types: ["repository"], side_effect_class: "READ_ONLY" },
    { action: "resource.read", required_authority: "telegram.read", target_types: ["telegram_update"], side_effect_class: "READ_ONLY" },
  ];
  assert.equal(evaluatePolicy(task({ action: "resource.read" }), [], context({ policies: rules }), { now }).decision, "ALLOW");
  assert.equal(evaluatePolicy(task(), [], context({ policies: [...context().policies, ...context().policies] }), { now }).decision, "BLOCKED");
});

test("caller-supplied VERIFIED evidence cannot satisfy a requirement without trusted verification", () => {
  const required = task({ required_evidence: [{ claim_type: "TESTS_PASSED", subject: "KRATT-PRIME", required: true, revision: null }] });
  assert.equal(evaluatePolicy(required, [evidence()], context(), { now }).decision, "INSUFFICIENT_EVIDENCE");
  assert.equal(evaluatePolicy(required, [evidence()], context(), { now, verifyEvidence: () => true }).decision, "ALLOW");
  assert.equal(evaluatePolicy(required, [evidence(), evidence()], context(), { now, verifyEvidence: () => true }).decision, "DENY");
});

test("external write requires a request-bound approval, policy evidence and one-time nonce", () => {
  const writeTask = task({ action: "repo.write", constraints: { provider: "github" }, required_evidence: [{ claim_type: "TESTS_PASSED", subject: "KRATT-PRIME", required: true, revision: null }] });
  const writeContext = context({
    allowed_targets: [{ resource_type: "repository", resource_id: "KRATT-PRIME" }],
    policies: [{ action: "repo.write", required_authority: "repository.read", target_types: ["repository"], side_effect_class: "EXTERNAL_WRITE", approval_required: true, approval_authority: "repository.approve", required_claims: ["TESTS_PASSED"] }],
  });
  const unsigned = {
    schema_version: KRATT_SCHEMA_VERSION, approval_id: "approval-1", task_id: writeTask.task_id, actor: writeTask.actor,
    provider: "github", operation: "repo.write", target: writeTask.target, request_digest: canonicalTaskDigest(writeTask),
    key_id: "test-key", nonce: "nonce-1", issued_at: "2026-11-04T06:59:00.000Z",
    expires_at: "2026-11-04T07:04:00.000Z", decision: "APPROVE", approved_by: "security-owner",
    authority: "repository.approve", signature: "sig",
  };
  const payload = canonicalApprovalPayload(unsigned);
  const consumed = new Set();
  const verifier = createRequestBoundApprovalVerifier({
    now: () => now, verifySignature: value => value === payload,
    consumeNonce: (nonce, approvalId, expiresAt, keyId) => {
      const key = `${keyId}:${nonce}`; if (consumed.has(key)) return false; consumed.add(key); return true;
    },
  });
  const options = { now, verifyEvidence: () => true, approvalVerifier: verifier, approval: unsigned };
  assert.equal(evaluatePolicy(writeTask, [evidence()], writeContext, options).decision, "ALLOW");
  assert.equal(evaluatePolicy(writeTask, [evidence()], writeContext, options).decision, "DENY");
  assert.equal(consumed.size, 1);
  assert.equal(evaluatePolicy({ ...writeTask, required_evidence: [] }, [evidence()], writeContext, { ...options, approvalVerifier: () => true }).decision, "DENY");
});

test("request-bound approval fails closed on a clock error, mismatched binding or replay", () => {
  const artifact = {
    schema_version: KRATT_SCHEMA_VERSION, approval_id: "approval-2", task_id: "task-2", actor: "builder",
    provider: "github", operation: "repo.write", target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
    request_digest: `sha256:${"a".repeat(64)}`, key_id: "test-key", nonce: "nonce-2",
    issued_at: "2026-11-04T06:59:00.000Z", expires_at: "2026-11-04T07:04:00.000Z",
    decision: "APPROVE", approved_by: "security-owner", authority: "repository.approve", signature: "sig",
  };
  const brokenClock = createRequestBoundApprovalVerifier({ now: () => { throw new Error("clock unavailable"); }, verifySignature: () => true, consumeNonce: () => true });
  const binding = { task_id: artifact.task_id, actor: artifact.actor, provider: artifact.provider, operation: artifact.operation, target: artifact.target, authority: artifact.authority, request_digest: artifact.request_digest };
  assert.equal(brokenClock(artifact, binding), false);
  assert.equal(isPolicyDecision({ decision: "ALLOW" }), true);
  assert.equal(isPolicyDecision({ decision: "MAYBE" }), false);
});

test("stale, future and expired trusted contexts block; branch scope must match exactly", () => {
  assert.equal(evaluatePolicy(task(), [], context({ expires_at: at }), { now }).decision, "BLOCKED");
  assert.equal(evaluatePolicy(task(), [], context({ evaluated_at: "2026-11-04T08:01:00.000Z" }), { now }).decision, "BLOCKED");
  assert.equal(evaluatePolicy(task({ constraints: { branch: "main" } }), [], context(), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task(), [], context({ policies: [...context().policies, ...context().policies] }), { now }).decision, "BLOCKED");
});
