import test from "node:test";
import assert from "node:assert/strict";
import { createConstructionTask, transitionConstructionTask } from "../src/construction-protocol.mjs";
import { reflectConstructionTask } from "../src/reflection-engine.mjs";

const clock = () => "2026-11-26T09:00:00Z";
const makeTask = (finalState = "IMPLEMENTED") => {
  let task = createConstructionTask({
    goal: "Add a safe construction workflow",
    base_commit: "0cf8b034e6f3ec12818d8b5b51ca2cdf12ba07c6",
    target_scope: ["packages/kratt-core/src"],
    required_evidence: ["unit-tests", "independent-review"],
    builder_id: "builder-1"
  }, { now: clock, id: () => "task-01" }).task;
  task = transitionConstructionTask(task, { to: "IN_REVIEW", actor_id: "reviewer-1", at: clock() }).task;
  task = transitionConstructionTask(task, { to: "APPROVED", actor_id: "reviewer-1", evidence_refs: ["approval-1"], at: clock() }).task;
  task = transitionConstructionTask(task, {
    to: "IMPLEMENTED", actor_id: "builder-1",
    change_digest: `sha256:${"a".repeat(64)}`, at: clock()
  }).task;
  if (finalState === "VERIFIED") {
    task = transitionConstructionTask(task, { to: "VERIFIED", actor_id: "verifier-1", evidence_refs: ["tests-1", "review-1"], at: clock() }).task;
  }
  return task;
};

const allPass = [
  { evidence_id: "tests-1", requirement: "unit-tests", result: "PASS" },
  { evidence_id: "review-1", requirement: "independent-review", result: "PASS" }
];

test("all evidence on implemented task recommends independent verification", () => {
  const result = reflectConstructionTask(makeTask(), { evidence: allPass, failed_checks: [] });
  assert.equal(result.ok, true);
  assert.equal(result.report.outcome, "READY_FOR_INDEPENDENT_VERIFICATION");
  assert.equal(result.report.follow_up, null);
});

test("failed checks produce a bounded rework proposal, not an automatic task", () => {
  const result = reflectConstructionTask(makeTask(), {
    evidence: [{ evidence_id: "tests-1", requirement: "unit-tests", result: "FAIL" }],
    failed_checks: ["Regression test failed"]
  });
  assert.equal(result.report.outcome, "NEEDS_REWORK");
  assert.equal(result.report.follow_up.kind, "REWORK_PROPOSAL");
  assert.equal(result.report.follow_up.parent_task_id, "task-01");
});

test("missing required evidence is distinguished from a failed check", () => {
  const result = reflectConstructionTask(makeTask(), {
    evidence: [{ evidence_id: "tests-1", requirement: "unit-tests", result: "PASS" }]
  });
  assert.equal(result.report.outcome, "INSUFFICIENT_EVIDENCE");
  assert.deepEqual(result.report.missing_requirements, ["independent-review"]);
});

test("verified task with complete evidence is complete", () => {
  const result = reflectConstructionTask(makeTask("VERIFIED"), { evidence: allPass });
  assert.equal(result.report.outcome, "COMPLETE");
});

test("reflection rejects malformed or duplicate evidence references", () => {
  const result = reflectConstructionTask(makeTask(), {
    evidence: [
      { evidence_id: "same", requirement: "unit-tests", result: "PASS" },
      { evidence_id: "same", requirement: "independent-review", result: "PASS" }
    ]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_EVIDENCE_OBSERVATION");
});

test("reflection does not accept a task before implementation", () => {
  const task = createConstructionTask({
    goal: "Build", base_commit: "0cf8b034e6f3ec12818d8b5b51ca2cdf12ba07c6",
    target_scope: ["src"], required_evidence: ["unit-tests"], builder_id: "builder-1"
  }, { now: clock, id: () => "task-early" }).task;
  assert.equal(reflectConstructionTask(task, { evidence: [] }).reason, "TASK_NOT_READY_FOR_REFLECTION");
});
