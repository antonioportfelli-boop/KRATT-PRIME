import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_LEDGER_KEY,
  appendExecutionRecord,
  cancelExecution,
  claimExecution,
  completeExecution,
  createExecutionRecord,
  deriveExecutionKey,
  failExecution,
  recoverExecutionRecords,
  startExecution
} from "../src/construction-execution-ledger.mjs";

const at = "2026-11-26T12:00:00.000Z";
const task = {
  task_id: "task-001",
  task_revision: 2,
  task_digest: `sha256:${"a".repeat(64)}`,
  operation: "build"
};
const clock = () => at;
const create = overrides => createExecutionRecord({ ...task, now: clock, ...overrides });
const claim = (fence = 1, worker = "worker-1") => ({
  worker_id: worker, lease_id: `lease-${fence}`, fence,
  expires_at: "2026-11-26T12:10:00.000Z"
});

class MemoryStore {
  entries = [];
  async open() { return this; }
  async put({ idempotencyKey, key, value }) {
    if (this.entries.some(x => x.id === idempotencyKey))
      return { ok: true, duplicate: true };
    this.entries.push({ id: idempotencyKey, key, value, sequence: this.entries.length + 1 });
    return { ok: true, duplicate: false, sequence: this.entries.length, hash: "c".repeat(64) };
  }
  async readAll() { return structuredClone(this.entries); }
  async verify() { return { ok: true, count: this.entries.length, headHash: "d".repeat(64) }; }
}

test("execution key is deterministic and scoped to immutable task revision and operation", () => {
  const first = deriveExecutionKey(task);
  const same = deriveExecutionKey({ ...task });
  const different = deriveExecutionKey({ ...task, operation: "test" });
  assert.equal(first.ok, true);
  assert.equal(first.execution_key, same.execution_key);
  assert.notEqual(first.execution_key, different.execution_key);
});

test("record creation starts queued and is tamper evident", () => {
  const result = create();
  assert.equal(result.ok, true);
  assert.equal(result.record.state, "QUEUED");
  assert.equal(result.record.attempts, 0);
  assert.match(result.record.record_digest, /^sha256:[a-f0-9]{64}$/);
});

test("claim, start and complete follow the guarded lifecycle", () => {
  const created = create();
  const claimed = claimExecution(created.record, claim(), { now: clock });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.record.state, "CLAIMED");
  assert.equal(claimed.record.attempts, 1);
  const running = startExecution(claimed.record, claim(), { now: clock });
  assert.equal(running.ok, true);
  assert.equal(running.record.state, "RUNNING");
  const done = completeExecution(running.record, claim(), `sha256:${"b".repeat(64)}`, { now: clock });
  assert.equal(done.ok, true);
  assert.equal(done.record.state, "SUCCEEDED");
  assert.equal(done.record.claim, null);
});

test("stale fence and mismatched claim fail closed", () => {
  const first = claimExecution(create().record, claim(4), { now: clock });
  assert.equal(first.ok, true);
  const stale = claimExecution({ ...first.record, record_digest: first.record.record_digest }, claim(3), { now: clock });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "EXECUTION_NOT_CLAIMABLE");
  const mismatch = startExecution(first.record, claim(5), { now: clock });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "CLAIM_MISMATCH");
});

test("expired claim cannot start or complete work", () => {
  const expired = { ...claim(), expires_at: "2026-11-26T11:59:00.000Z" };
  const claimed = claimExecution(create().record, expired, { now: clock });
  assert.equal(claimed.ok, false);
  assert.equal(claimed.reason, "CLAIM_INVALID_OR_EXPIRED");
});

test("retryable failure enters retry wait only while attempts remain", () => {
  const first = claimExecution(create({ max_attempts: 2 }).record, claim(1), { now: clock });
  const running = startExecution(first.record, claim(1), { now: clock });
  const failed = failExecution(running.record, claim(1), "transient network error", { retryable: true, now: clock });
  assert.equal(failed.ok, true);
  assert.equal(failed.record.state, "RETRY_WAIT");
  const second = claimExecution(failed.record, claim(2), { now: clock });
  assert.equal(second.ok, true);
  assert.equal(second.record.attempts, 2);
  const exhausted = failExecution(second.record, claim(2), "permanent failure", { retryable: true, now: clock });
  assert.equal(exhausted.ok, true);
  assert.equal(exhausted.record.state, "FAILED");
});

test("non-retryable failure is terminal", () => {
  const claimed = claimExecution(create().record, claim(), { now: clock });
  const failed = failExecution(claimed.record, claim(), "policy blocked", { retryable: false, now: clock });
  assert.equal(failed.ok, true);
  assert.equal(failed.record.state, "FAILED");
  assert.equal(claimExecution(failed.record, claim(2), { now: clock }).reason, "EXECUTION_NOT_CLAIMABLE");
});

test("cancellation is explicit and terminal", () => {
  const cancelled = cancelExecution(create().record, "operator-1", "operator requested", { now: clock });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.record.state, "CANCELLED");
  assert.equal(cancelExecution(cancelled.record, "operator-1", "again", { now: clock }).reason, "EXECUTION_TERMINAL");
});

test("append and verified recovery never replay execution", async () => {
  const store = new MemoryStore();
  const record = create().record;
  const appended = await appendExecutionRecord(record, store);
  const replay = await appendExecutionRecord(record, store);
  assert.equal(appended.ok, true);
  assert.equal(appended.duplicate, false);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].key, EXECUTION_LEDGER_KEY);
  const recovered = await recoverExecutionRecords(store);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.count, 1);
  assert.equal(recovered.records[0].execution_key, record.execution_key);
});

test("recovery fails closed when journal verification fails", async () => {
  const store = new MemoryStore();
  store.verify = async () => ({ ok: false });
  const result = await recoverExecutionRecords(store);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTION_JOURNAL_INTEGRITY_FAILURE");
});

test("invalid or tampered records cannot be claimed", () => {
  const tampered = { ...create().record, attempts: 1 };
  const result = claimExecution(tampered, claim(), { now: clock });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTION_RECORD_INVALID");
});

test("duplicate persistence key with different payload is rejected", async () => {
  const store = new MemoryStore();
  const original = create().record;
  await appendExecutionRecord(original, store);
  const changed = create({ max_attempts: 4 }).record;
  // Same logical identity must not silently overwrite the previously persisted payload.
  const collision = await appendExecutionRecord(changed, store);
  assert.equal(collision.ok, false);
  assert.equal(collision.reason, "EXECUTION_IDEMPOTENCY_CONFLICT");
});
