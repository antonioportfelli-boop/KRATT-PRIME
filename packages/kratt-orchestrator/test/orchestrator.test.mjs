import test from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../src/orchestrator.mjs";

const stamp = "2026-11-10T12:00:00.000Z";
const testOrchestrator = options => createOrchestrator({
  verifyAdapterEvidence: (artifact, binding) =>
    artifact?.attestation === "test-signed" && artifact?.adapterId === binding.adapterId,
  ...options,
});
const descriptor = (overrides = {}) => ({
  id: "github-main",
  name: "GitHub",
  kind: "source-control",
  capabilities: ["repo.read", "repo.write"],
  permissions: { read: true, write: true },
  ...overrides,
});

function ready(orchestrator, spec = descriptor(), implementation = {}) {
  const adapter = orchestrator.registerAdapter(spec, implementation);
  assert.equal(orchestrator.transitionAdapter(adapter.id, "CONNECTED_UNVERIFIED").status, "OK");
  assert.equal(orchestrator.transitionAdapter(adapter.id, "VERIFIED_READ_ONLY", {
    attestation: "test-signed",
    adapterId: adapter.id,
    verifierId: "test-verifier",
  }).status, "OK");
  return adapter;
}

test("adapters begin discovered; connector identity never implies trust", async () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  const adapter = orchestrator.registerAdapter(descriptor(), { read: async () => [] });
  assert.equal(adapter.state, "DISCOVERED");
  const blocked = await orchestrator.executeRead({
    adapterId: adapter.id,
    capability: "repo.read",
    input: {},
  });
  assert.equal(blocked.status, "BLOCKED");
});

test("unverified adapter cannot be promoted without verifier evidence", () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  const adapter = orchestrator.registerAdapter(descriptor());
  assert.equal(orchestrator.transitionAdapter(adapter.id, "VERIFIED_READ_ONLY").reason, "ILLEGAL_ADAPTER_STATE_TRANSITION");
  assert.equal(orchestrator.transitionAdapter(adapter.id, "CONNECTED_UNVERIFIED").status, "OK");
  assert.equal(orchestrator.transitionAdapter(adapter.id, "VERIFIED_READ_ONLY").reason, "TRUSTED_ADAPTER_VERIFIER_UNAVAILABLE");
});

test("verified read adapter executes only declared read capabilities", async () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  ready(orchestrator, descriptor(), { read: async ({ input }) => ({ items: input.limit }) });
  const allowed = await orchestrator.executeRead({
    adapterId: "github-main",
    capability: "repo.read",
    input: { limit: 4 },
  });
  assert.equal(allowed.status, "OK");
  assert.deepEqual(allowed.output, { items: 4 });
  const denied = await orchestrator.executeRead({
    adapterId: "github-main",
    capability: "repo.admin",
    input: {},
  });
  assert.equal(denied.status, "DENY");
});

test("write requires request-bound approval and returns adapter to read-only state", async () => {
  const calls = [];
  const orchestrator = createOrchestrator({
    now: () => stamp,
    verifyApproval: (artifact, binding) => artifact?.requestId === binding.requestId &&
      artifact?.payloadDigest === binding.payloadDigest &&
      artifact?.actor === binding.actor,
  });
  ready(orchestrator, descriptor(), {
    read: async () => [],
    write: async args => { calls.push(args); return { accepted: true }; },
  });
  const requested = orchestrator.requestWrite({
    adapterId: "github-main",
    capability: "repo.write",
    target: "feature/test",
    payload: { operation: "create-file" },
    actor: "architect",
  });
  assert.equal(requested.status, "PENDING_APPROVAL");
  const approval = {
    requestId: requested.request.requestId,
    payloadDigest: requested.request.payloadDigest,
    actor: requested.request.actor,
  };
  const completed = await orchestrator.approveAndExecuteWrite({
    requestId: requested.request.requestId,
    approval,
  });
  assert.equal(completed.status, "OK");
  assert.equal(calls.length, 1);
  assert.equal(orchestrator.snapshot().adapters[0].state, "VERIFIED_READ_ONLY");
});

test("missing, mismatched and replayed approval artifacts cannot execute writes", async () => {
  let calls = 0;
  const orchestrator = createOrchestrator({
    now: () => stamp,
    verifyApproval: (artifact, binding) => artifact?.requestId === binding.requestId,
  });
  ready(orchestrator, descriptor(), { write: async () => { calls += 1; return {}; } });
  const request = orchestrator.requestWrite({
    adapterId: "github-main",
    capability: "repo.write",
    target: "feature/test",
    payload: { operation: "write" },
    actor: "architect",
  });
  const denied = await orchestrator.approveAndExecuteWrite({
    requestId: request.request.requestId,
    approval: { requestId: "different-request" },
  });
  assert.equal(denied.status, "DENY");
  assert.equal(calls, 0);
  const replay = await orchestrator.approveAndExecuteWrite({
    requestId: request.request.requestId,
    approval: { requestId: request.request.requestId },
  });
  assert.equal(replay.status, "NOT_FOUND");
});

test("write cannot be enabled by a generic lifecycle transition", () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  const adapter = ready(orchestrator);
  assert.equal(orchestrator.transitionAdapter(adapter.id, "WRITE_ENABLED").reason,
    "WRITE_ENABLEMENT_REQUIRES_REQUEST_BOUND_APPROVAL");
});

test("event journal is append-only and verifies its hash chain", async () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  ready(orchestrator, descriptor(), { read: async () => ({ ok: true }) });
  await orchestrator.executeRead({
    adapterId: "github-main",
    capability: "repo.read",
    input: {},
  });
  const verification = orchestrator.verifyJournal();
  assert.equal(verification.status, "OK");
  assert.equal(verification.eventCount, 4);
  assert.ok(verification.head.startsWith("sha256:"));
});

test("disabled adapter cannot read even when a handler exists", async () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  const adapter = ready(orchestrator, descriptor(), { read: async () => ({ leaked: true }) });
  assert.equal(orchestrator.transitionAdapter(adapter.id, "DISABLED").status, "OK");
  const response = await orchestrator.executeRead({
    adapterId: adapter.id,
    capability: "repo.read",
    input: {},
  });
  assert.equal(response.status, "BLOCKED");
});


test("pending write requests expire and restore the verified read-only state", async () => {
  let current = Date.parse(stamp);
  const orchestrator = testOrchestrator({
    now: () => new Date(current).toISOString(),
    verifyApproval: () => true,
  });
  ready(orchestrator, descriptor(), { write: async () => ({ accepted:true }) });
  const request = orchestrator.requestWrite({
    adapterId:"github-main",
    capability:"repo.write",
    target:"feature/test",
    payload:{ operation:"write" },
    actor:"architect",
  });
  current += 5 * 60_000;
  const expired = await orchestrator.approveAndExecuteWrite({
    requestId:request.request.requestId,
    approval:{ signature:"not-relevant-after-expiry" },
  });
  assert.equal(expired.reason, "WRITE_REQUEST_EXPIRED");
  assert.equal(orchestrator.snapshot().adapters[0].state, "VERIFIED_READ_ONLY");
});

test("write request cancellation is actor-bound", () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  ready(orchestrator, descriptor(), { write: async () => ({}) });
  const request = orchestrator.requestWrite({
    adapterId:"github-main",
    capability:"repo.write",
    target:"feature/test",
    payload:{ operation:"write" },
    actor:"architect",
  });
  assert.equal(orchestrator.cancelWriteRequest({
    requestId:request.request.requestId,
    actor:"other-actor",
  }).status, "DENY");
  assert.equal(orchestrator.cancelWriteRequest({
    requestId:request.request.requestId,
    actor:"architect",
  }).status, "OK");
  assert.equal(orchestrator.snapshot().adapters[0].state, "VERIFIED_READ_ONLY");
});

test("non-canonical payloads are rejected before a write request is queued", () => {
  const orchestrator = testOrchestrator({ now: () => stamp });
  ready(orchestrator, descriptor());
  const circular = {};
  circular.self = circular;
  const denied = orchestrator.requestWrite({
    adapterId:"github-main",
    capability:"repo.write",
    target:"feature/test",
    payload:circular,
    actor:"architect",
  });
  assert.equal(denied.reason, "WRITE_PAYLOAD_NOT_CANONICAL");
});
