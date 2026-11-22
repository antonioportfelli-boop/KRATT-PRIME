import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { KRATT_SCHEMA_VERSION, validateTaskEnvelope, validateTrustedContext } from "../src/contracts.mjs";
import { canonicalApprovalPayload, canonicalTaskDigest, evaluatePolicy } from "../src/policy.mjs";
import { createTrustedAuthorizationRuntime } from "../src/trusted-runtime.mjs";
import { MemoryLedger } from "../src/memory-ledger.mjs";
import { createSaga, transitionSaga } from "../src/saga.mjs";
import { AgentRegistry } from "../src/agent-registry.mjs";

const at = "2026-11-04T08:00:00.000Z";
const now = Date.parse(at);
const task = (overrides = {}) => ({
  schema_version: KRATT_SCHEMA_VERSION, task_id: "task-1", actor: "builder", action: "repo.read",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" }, constraints: { branch: "integration" },
  required_evidence: [], created_at: at, requested_authority: ["untrusted.request.authority"], status: "PENDING", ...overrides,
});
const context = (overrides = {}) => ({
  schema_version: KRATT_SCHEMA_VERSION, authorities: ["repository.read", "repository.approve"],
  allowed_targets: [{ resource_type: "repository", resource_id: "KRATT-PRIME", branch: "integration" }],
  policies: [{ action: "repo.read", required_authority: "repository.read", target_types: ["repository"], side_effect_class: "READ_ONLY" }],
  evaluated_at: at, expires_at: "2026-11-04T08:05:00.000Z", kill_switch: false, ...overrides,
});
const evidence = (overrides = {}) => ({
  schema_version: KRATT_SCHEMA_VERSION, evidence_id: "evidence-1", subject: "KRATT-PRIME", claim_type: "TESTS_PASSED",
  source: { source_type: "github", source_id: "run-1", revision: "0123456789012345678901234567890123456789" },
  observed_at: at, verification_method: "signed-attestation", result: "VERIFIED", artifact_digest: null, metadata: {}, ...overrides,
});

test("task and trusted-context contracts reject privilege injection and unsafe shapes", () => {
  assert.equal(validateTaskEnvelope(task()).ok, true);
  assert.equal(validateTaskEnvelope({ ...task(), isAdmin: true }).ok, false);
  const accessor = task(); Object.defineProperty(accessor, "admin", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.equal(validateTaskEnvelope(accessor).ok, false);
  const sparse = []; sparse.length = 1;
  assert.equal(validateTaskEnvelope(task({ required_evidence: sparse })).ok, false);
  assert.equal(validateTrustedContext(context()).ok, true);
  assert.equal(validateTrustedContext({ ...context(), expires_at: undefined }).ok, false);
});

test("policy denies task-requested authority, out-of-scope targets and kill-switch actions", () => {
  assert.equal(evaluatePolicy(task(), [], context(), { now }).decision, "ALLOW");
  assert.equal(evaluatePolicy(task(), [], context({ authorities: [] }), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task({ target: { resource_type: "repository", resource_id: "OTHER" } }), [], context(), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task(), [], context({ kill_switch: true }), { now }).decision, "DENY");
  assert.equal(evaluatePolicy(task(), [], context(), {}).decision, "BLOCKED");
});

test("same-action overlapping policies block while distinct target types do not conflict", async () => {
  const policies = [
    { action: "resource.read", required_authority: "repository.read", target_types: ["repository"], side_effect_class: "READ_ONLY" },
    { action: "resource.read", required_authority: "telegram.read", target_types: ["telegram_update"], side_effect_class: "READ_ONLY" },
  ];
  assert.equal(evaluatePolicy(task({ action: "resource.read" }), [], context({ policies }), { now }).decision, "ALLOW");
  assert.equal(evaluatePolicy(task(), [], context({ policies: [...context().policies, ...context().policies] }), { now }).decision, "BLOCKED");
});

test("Memory Ledger is append-only, detects duplicate IDs and verifies its digest chain", () => {
  const ledger = new MemoryLedger();
  assert.equal(ledger.append({ id: "m1", kind: "finding", createdAt: at, payload: { digest: "abc" } }).ok, true);
  assert.equal(ledger.append({ id: "m1", kind: "finding", createdAt: at, payload: { digest: "x" } }).reason, "DUPLICATE_MEMORY_ID");
  assert.equal(ledger.verify().ok, true);
});

test("Saga state machine rejects invalid transitions and freezes its event history", () => {
  let saga = createSaga({ id: "s1", goal: "audit", createdAt: at });
  saga = transitionSaga(saga, "RUNNING", { id: "e1", at, kind: "start", meta: { source: "github" } }).value;
  assert.equal(transitionSaga(saga, "PENDING", { id: "e2", at, kind: "rewind" }).reason, "INVALID_STATE_TRANSITION");
  assert.equal(Object.isFrozen(saga.events[0].meta), true);
});

test("Agent Registry prevents privilege escalation and enforces tool scopes", () => {
  const registry = new AgentRegistry();
  assert.equal(registry.registerAgent({ id: "builder", scopes: ["repository.read"], status: "active" }).ok, true);
  assert.equal(registry.registerAgent({ id: "root", scopes: ["production.deploy"], status: "active" }).reason, "INVALID_AGENT");
  registry.registerTool({ name: "read", requiredScopes: ["repository.read"] });
  assert.equal(registry.authorize("builder", "read", "repository.read").allowed, true);
  assert.equal(registry.authorize("builder", "read", "production.deploy").allowed, false);
});

test("trusted composition root verifies Ed25519 approval and atomically rejects nonce replay", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const writeTask = task({
    action: "repo.write", constraints: { provider: "github" },
    required_evidence: [{ claim_type: "TESTS_PASSED", subject: "KRATT-PRIME", required: true, revision: null }],
  });
  const writeContext = context({
    authorities: ["repository.read", "repository.approve"],
    allowed_targets: [{ resource_type: "repository", resource_id: "KRATT-PRIME" }],
    policies: [{ action: "repo.write", required_authority: "repository.read", target_types: ["repository"], side_effect_class: "EXTERNAL_WRITE", approval_required: true, approval_authority: "repository.approve", required_claims: ["TESTS_PASSED"] }],
  });
  const unsigned = {
    schema_version: KRATT_SCHEMA_VERSION, approval_id: "approval-1", task_id: writeTask.task_id, actor: writeTask.actor,
    provider: "github", operation: "repo.write", target: writeTask.target, request_digest: canonicalTaskDigest(writeTask),
    key_id: "test-key", nonce: "nonce-1", issued_at: "2026-11-04T07:59:00.000Z", expires_at: "2026-11-04T08:04:00.000Z",
    decision: "APPROVE", approved_by: "security-owner", authority: "repository.approve", signature: "placeholder",
  };
  const payload = canonicalApprovalPayload(unsigned);
  const approval = { ...unsigned, signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url") };
  const used = new Set();
  const runtime = createTrustedAuthorizationRuntime({
    trustedApprovalKeys: [{ key_id: "test-key", approver_id: "security-owner", public_key_pem: publicKey.export({ type: "spki", format: "pem" }), authorities: ["repository.approve"] }],
    nonceStore: { consume: (keyId, nonce) => { const id = keyId + ":" + nonce; if (used.has(id)) return false; used.add(id); return true; } },
    verifyEvidence: record => record.source.source_type === "github" && record.verification_method === "signed-attestation",
    now: () => now,
  });
  const requiredEvidence = [evidence()];
  const opts = { approval };
  assert.equal(runtime.evaluate(writeTask, requiredEvidence, writeContext, opts).decision, "ALLOW");
  assert.equal(runtime.evaluate(writeTask, requiredEvidence, writeContext, opts).decision, "DENY");
  assert.equal(used.size, 1);
});

test("trusted composition root rejects missing nonce storage and an unavailable trusted clock", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const key = { key_id: "key-1", approver_id: "security-owner", public_key_pem: publicKey.export({ type: "spki", format: "pem" }), authorities: ["repository.approve"] };
  const base = { trustedApprovalKeys: [key], verifyEvidence: () => true, now: () => now };
  assert.throws(() => createTrustedAuthorizationRuntime({ ...base, nonceStore: {} }), /DURABLE_NONCE_STORE_REQUIRED/);
  assert.throws(() => createTrustedAuthorizationRuntime({ ...base, nonceStore: { consume: () => true }, now: () => { throw new Error("clock"); } }), /TRUSTED_CLOCK_UNAVAILABLE/);
});

