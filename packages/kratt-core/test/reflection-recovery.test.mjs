import test from "node:test";
import assert from "node:assert/strict";
import { createConstructionTask, transitionConstructionTask } from "../src/construction-protocol.mjs";
import {
  CONSTRUCTION_REFLECTION_RECORD_KEY,
  recordConstructionReflection,
  recoverConstructionReflections
} from "../src/reflection-recovery.mjs";

class FakePrimeStore {
  entries = [];
  async open() { return this; }
  async put({ idempotencyKey, key, value }) {
    if (this.entries.some(entry => entry.id === idempotencyKey))
      return { ok: true, duplicate: true, sequence: null };
    const sequence = this.entries.length + 1;
    this.entries.push({ sequence, id: idempotencyKey, key, value });
    return { ok: true, duplicate: false, sequence, hash: "a".repeat(64) };
  }
  async readAll() { return structuredClone(this.entries); }
  async verify() { return { ok: true, count: this.entries.length, headHash: "b".repeat(64) }; }
}

const at = "2026-11-26T09:00:00Z";
const makeTask = () => {
  let task = createConstructionTask({
    goal: "Verify a construction result",
    base_commit: "0cf8b034e6f3ec12818d8b5b51ca2cdf12ba07c6",
    target_scope: ["packages/kratt-core/src"],
    required_evidence: ["unit-tests", "independent-review"],
    builder_id: "builder-1"
  }, { now: () => at, id: () => "task-01" }).task;
  task = transitionConstructionTask(task, { to: "IN_REVIEW", actor_id: "reviewer-1", at }).task;
  task = transitionConstructionTask(task, {
    to: "APPROVED", actor_id: "reviewer-1", evidence_refs: ["approval-1"], at
  }).task;
  return transitionConstructionTask(task, {
    to: "IMPLEMENTED", actor_id: "builder-1",
    change_digest: `sha256:${"a".repeat(64)}`, at
  }).task;
};
const observations = {
  evidence: [
    { evidence_id: "tests-1", requirement: "unit-tests", result: "PASS" },
    { evidence_id: "review-1", requirement: "independent-review", result: "PASS" }
  ],
  failed_checks: []
};

test("reflection record is appended and recovered from a verified journal", async () => {
  const store = new FakePrimeStore();
  const result = await recordConstructionReflection({ task: makeTask(), observations, store, now: () => at });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.record.report.outcome, "READY_FOR_INDEPENDENT_VERIFICATION");
  assert.equal(store.entries[0].key, CONSTRUCTION_REFLECTION_RECORD_KEY);

  const recovered = await recoverConstructionReflections({ store });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.count, 1);
  assert.equal(recovered.records[0].record_digest, result.record.record_digest);
});

test("identical reflection retries are idempotent", async () => {
  const store = new FakePrimeStore();
  const first = await recordConstructionReflection({ task: makeTask(), observations, store, now: () => at });
  const replay = await recordConstructionReflection({ task: makeTask(), observations, store, now: () => at });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(store.entries.length, 1);
});

test("different evidence observations produce a distinct journal record", async () => {
  const store = new FakePrimeStore();
  const task = makeTask();
  await recordConstructionReflection({ task, observations, store, now: () => at });
  const changed = { ...observations, failed_checks: ["Independent check requested"] };
  const second = await recordConstructionReflection({ task, observations: changed, store, now: () => at });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, false);
  assert.equal(store.entries.length, 2);
  assert.equal(second.report.outcome, "NEEDS_REWORK");
});

test("recovery rejects malformed reflection records", async () => {
  const store = new FakePrimeStore();
  store.entries.push({
    sequence: 1, id: "reflect-bad", key: CONSTRUCTION_REFLECTION_RECORD_KEY,
    value: { schema_version: "kratt-reflection-journal/v1", record_digest: "sha256:" + "0".repeat(64) }
  });
  const recovered = await recoverConstructionReflections({ store });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.reason, "REFLECTION_RECORD_INVALID");
});

test("reflection journal does not accept unverified task state", async () => {
  const store = new FakePrimeStore();
  const task = { ...makeTask(), status: "VERIFIED" };
  const result = await recordConstructionReflection({ task, observations, store, now: () => at });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "TASK_INTEGRITY_INVALID");
  assert.equal(store.entries.length, 0);
});
