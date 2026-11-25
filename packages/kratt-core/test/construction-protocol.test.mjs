import test from "node:test";
import assert from "node:assert/strict";
import {
  createConstructionTask,
  transitionConstructionTask,
  verifyConstructionTask
} from "../src/construction-protocol.mjs";

const input = {
  goal: "Fix policy parsing and add regression coverage",
  base_commit: "0cf8b034e6f3ec12818d8b5b51ca2cdf12ba07c6",
  target_scope: ["packages/kratt-core/src/policy.mjs", "packages/kratt-core/test"],
  required_evidence: ["tests-pass", "independent-review"],
  builder_id: "builder-1"
};
const clock = () => "2026-11-26T09:00:00Z";
const make = () => createConstructionTask(input, { now: clock, id: () => "task-001" }).task;

test("construction task validates and freezes its scope", () => {
  const result = createConstructionTask(input, { now: clock, id: () => "task-001" });
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.task), true);
  assert.deepEqual(result.task.target_scope, [...input.target_scope].sort());
  assert.match(result.task_digest, /^sha256:[a-f0-9]{64}$/);
});

test("task creation rejects malformed base commit and missing evidence", () => {
  assert.equal(createConstructionTask({ ...input, base_commit: "main" }, { now: clock }).reason, "INVALID_BASE_COMMIT");
  assert.equal(createConstructionTask({ ...input, required_evidence: [] }, { now: clock }).reason, "INVALID_REQUIRED_EVIDENCE");
});

test("builder cannot approve or verify their own work", () => {
  const proposed = make();
  const review = transitionConstructionTask(proposed, { to: "IN_REVIEW", actor_id: "reviewer-1", at: clock() });
  assert.equal(review.ok, true);
  assert.equal(transitionConstructionTask(review.task, {
    to: "APPROVED", actor_id: "builder-1", evidence_refs: ["review-1"], at: clock()
  }).reason, "BUILDER_CANNOT_APPROVE_OWN_TASK");
});

test("workflow requires evidence and a change digest before completion", () => {
  let result = transitionConstructionTask(make(), { to: "IN_REVIEW", actor_id: "reviewer-1", at: clock() });
  result = transitionConstructionTask(result.task, {
    to: "APPROVED", actor_id: "reviewer-1", evidence_refs: ["review-1"], at: clock()
  });
  assert.equal(result.ok, true);
  assert.equal(transitionConstructionTask(result.task, {
    to: "IMPLEMENTED", actor_id: "builder-1", at: clock()
  }).reason, "CHANGE_DIGEST_REQUIRED");
  result = transitionConstructionTask(result.task, {
    to: "IMPLEMENTED", actor_id: "builder-1",
    change_digest: `sha256:${"a".repeat(64)}`, at: clock()
  });
  assert.equal(result.ok, true);
  assert.equal(transitionConstructionTask(result.task, {
    to: "VERIFIED", actor_id: "builder-1", evidence_refs: ["tests-1"], at: clock()
  }).reason, "BUILDER_CANNOT_VERIFY_OWN_TASK");
  result = transitionConstructionTask(result.task, {
    to: "VERIFIED", actor_id: "verifier-1", evidence_refs: ["tests-1", "review-1"], at: clock()
  });
  assert.equal(result.ok, true);
  assert.equal(verifyConstructionTask(result.task).ok, true);
});

test("illegal state jumps and tampered history fail closed", () => {
  const proposed = make();
  assert.equal(transitionConstructionTask(proposed, {
    to: "VERIFIED", actor_id: "verifier-1", evidence_refs: ["tests-1"], at: clock()
  }).reason, "TRANSITION_NOT_ALLOWED");
  const moved = transitionConstructionTask(proposed, {
    to: "IN_REVIEW", actor_id: "reviewer-1", at: clock()
  }).task;
  const tampered = { ...moved, status: "VERIFIED" };
  assert.equal(verifyConstructionTask(tampered).reason, "STATUS_HISTORY_MISMATCH");
});
