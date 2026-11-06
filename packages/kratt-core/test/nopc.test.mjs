import test from "node:test";
import assert from "node:assert/strict";
import { createInteractionPreferences, proposeAgentPlan } from "../src/nopc.mjs";

test("interaction preferences are user-selected and normalized", () => {
  const result = createInteractionPreferences({ mode: "DEEP_FOCUS", reducedMotion: true, textScale: 1.2 });
  assert.equal(result.ok, true);
  assert.equal(result.value.source, "USER_SELECTED");
  assert.equal(result.value.mode, "DEEP_FOCUS");
  assert.equal(result.value.reducedMotion, true);
});

test("interaction preferences reject clinical or unknown fields", () => {
  assert.equal(createInteractionPreferences({ mode: "BIPOLAR" }).reason, "MODE_UNSUPPORTED");
  assert.equal(createInteractionPreferences({ diagnosis: "anything" }).reason, "PREFERENCES_SHAPE_INVALID");
  assert.equal(createInteractionPreferences({ textScale: 9 }).reason, "TEXT_SCALE_OUT_OF_RANGE");
});

test("planner respects dependencies and capability declarations", () => {
  const result = proposeAgentPlan({
    tasks: [
      { id: "task-b", dependsOn: ["task-a"], requiredCapabilities: ["repo.write"], priority: 10 },
      { id: "task-a", dependsOn: [], requiredCapabilities: ["repo.read"], priority: 1 }
    ],
    agents: [
      { id: "reader", capabilities: ["repo.read"], maxConcurrent: 1 },
      { id: "writer", capabilities: ["repo.read", "repo.write"], maxConcurrent: 1 }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.assignments.map(x => x.taskId), ["task-a", "task-b"]);
  assert.equal(result.plan.state, "PROPOSAL_ONLY");
  assert.equal(result.plan.executionStarted, false);
  assert.equal(result.plan.agentPrivilegeChanges, false);
});

test("planner blocks tasks when no agent has declared capabilities", () => {
  const result = proposeAgentPlan({
    tasks: [{ id: "task-a", requiredCapabilities: ["production.deploy"] }],
    agents: [{ id: "read-only", capabilities: ["repo.read"] }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.assignments.length, 0);
  assert.equal(result.plan.blocked[0].reason, "NO_CAPABLE_AGENT");
});

test("planner rejects duplicate IDs and invalid dependencies", () => {
  assert.equal(proposeAgentPlan({
    tasks: [{ id: "same" }, { id: "same" }], agents: []
  }).reason, "DUPLICATE_TASK_ID");
  assert.equal(proposeAgentPlan({
    tasks: [{ id: "a", dependsOn: ["missing"] }], agents: []
  }).reason, "DEPENDENCY_INVALID");
});

test("planner reports dependency cycles without executing work", () => {
  const result = proposeAgentPlan({
    tasks: [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] }
    ],
    agents: [{ id: "general", capabilities: [] }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.assignments.length, 0);
  assert.equal(result.plan.unassignedTaskIds.length, 2);
  assert.equal(result.plan.executionStarted, false);
});
