import test from "node:test";
import assert from "node:assert/strict";
import { executeAuthorizedConstructionTask } from "../src/construction-execution-orchestrator.mjs";

const at = "2026-11-26T12:00:00.000Z";
const task = {
  schema_version: "kratt-prime/v0.1",
  task_id: "task-orchestrator-1",
  actor: "builder-1",
  action: "repo.read",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
  constraints: { provider: "github" },
  required_evidence: [],
  created_at: at,
  requested_authority: ["repository.read"],
  status: "PENDING"
};
const digest = "sha256:" + "a".repeat(64);
const claim = {
  worker_id: "worker-1",
  lease_id: "lease-1",
  fence: 1,
  expires_at: "2026-11-26T12:10:00.000Z"
};
function harness({ decision = "ALLOW", appendFailsAt = -99, executeThrows = false } = {}) {
  const calls = [];
  const records = new Map();
  const authorizationRuntime = {
    evaluate(...args) {
      calls.push("authorize");
      return { decision, reasons: [decision] };
    }
  };
  const leaseCoordinator = {
    async acquire(input) { calls.push("acquire"); return { ok: true, claim }; },
    async release(input) { calls.push("release"); return { ok: true }; }
  };
  const ledgerStore = {
    async append({ execution_key, expected_revision, record }) {
      calls.push("append:" + record.revision);
      if (record.revision === appendFailsAt) return { ok: false, reason: "TEST_APPEND_FAILURE" };
      const prior = records.get(execution_key);
      const actualRevision = prior ? prior.revision : -1;
      if (actualRevision !== expected_revision) return { ok: false, reason: "REVISION_CONFLICT" };
      if (record.revision !== expected_revision + 1) return { ok: false, reason: "REVISION_GAP" };
      records.set(execution_key, record);
      return { ok: true, sequence: records.size + record.revision, journal_hash: "f".repeat(64) };
    }
  };
  const execute = async input => {
    calls.push("execute");
    if (executeThrows) throw new Error("simulated execution fault");
    return { result_digest: digest, output: "not persisted" };
  };
  return { calls, records, authorizationRuntime, leaseCoordinator, ledgerStore, execute };
}
function run(h, overrides = {}) {
  return executeAuthorizedConstructionTask({
    task, evidence: [], trustedContext: {}, approval: undefined,
    authorizationRuntime: h.authorizationRuntime,
    leaseCoordinator: h.leaseCoordinator,
    ledgerStore: h.ledgerStore,
    execute: h.execute,
    worker_id: "worker-1",
    now: () => at,
    ...overrides
  });
}

test("authorized task persists each revision, then executes and completes", async () => {
  const h = harness();
  const result = await run(h);
  assert.equal(result.ok, true);
  assert.equal(result.state, "SUCCEEDED");
  assert.equal(result.revision, 3);
  assert.deepEqual(h.calls, ["append:0", "acquire", "authorize", "append:1", "append:2", "execute", "append:3", "release"]);
  assert.equal(h.records.get(result.execution_key).state, "SUCCEEDED");
});

test("authorization denial prevents executor call and releases lease", async () => {
  const h = harness({ decision: "DENY" });
  const result = await run(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "AUTHORIZATION_DENIED");
  assert.equal(h.calls.includes("execute"), false);
  assert.equal(h.calls.at(-1), "release");
});

test("initial intent must persist before lease acquisition", async () => {
  const h = harness({ appendFailsAt: 0 });
  const result = await run(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "TEST_APPEND_FAILURE");
  assert.equal(h.calls.includes("acquire"), false);
  assert.equal(h.calls.includes("execute"), false);
});

test("failure to persist running state prevents side effect", async () => {
  const h = harness({ appendFailsAt: 2 });
  const result = await run(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "TEST_APPEND_FAILURE");
  assert.equal(h.calls.includes("execute"), false);
  assert.equal(h.calls.at(-1), "release");
});

test("executor exception is recorded as terminal failure", async () => {
  const h = harness({ executeThrows: true });
  const result = await run(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTOR_FAILED");
  const record = [...h.records.values()][0];
  assert.equal(record.state, "FAILED");
  assert.equal(h.calls.at(-1), "release");
});

test("invalid result digest is rejected and recorded as failure", async () => {
  const h = harness();
  h.execute = async () => ({ result_digest: "not-a-digest" });
  const result = await run(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTOR_RESULT_INVALID");
  assert.equal([...h.records.values()][0].state, "FAILED");
});

test("lease acquisition failure prevents authorization and execution", async () => {
  const h = harness();
  h.leaseCoordinator.acquire = async () => ({ ok: false, reason: "NO_LEASE" });
  const result = await run(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_LEASE");
  assert.equal(h.calls.includes("authorize"), false);
  assert.equal(h.calls.includes("execute"), false);
});

test("missing revisioned store fails closed", async () => {
  const h = harness();
  const result = await run(h, { ledgerStore: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REVISIONED_LEDGER_STORE_REQUIRED");
  assert.equal(h.calls.includes("execute"), false);
});
