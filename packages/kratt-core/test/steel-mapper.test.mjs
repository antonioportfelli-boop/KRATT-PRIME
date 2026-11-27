import test from "node:test";
import assert from "node:assert/strict";
import {
  mapKrattTaskToSteel,
  KRATT_STEEL_ADAPTER_VERSION,
  STEEL_PROTOCOL_VERSION
} from "../src/integrations/steel/mapper.mjs";

const task = (overrides = {}) => ({
  schema_version: "kratt-prime/v0.1",
  task_id: "inventory-17",
  actor: "repo-scout",
  action: "repo.read",
  target: { resource_type: "repository", resource_id: "example/project" },
  constraints: { note: "not-forwarded" },
  required_evidence: [
    { claim_type: "TESTS_PASSED", subject: "example-project", required: true, revision: null }
  ],
  created_at: "2026-11-09T12:00:00Z",
  requested_authority: ["repository.read"],
  status: "PENDING",
  ...overrides
});

const route = (overrides = {}) => ({
  repository: "example/project",
  branch: "feature/agent-inventory-17",
  base_sha: "a".repeat(40),
  scope: ["packages"],
  required_evidence: ["evidence:repository-map"],
  resource_budget: {
    max_wall_ms: 10_000,
    max_output_bytes: 16_384,
    max_files: 32
  },
  ...overrides
});

test("maps an authorized KRATT repository-read task to the STEEL v1 read-only envelope", async () => {
  const result = await mapKrattTaskToSteel(task(), {
    route: route(),
    authorizeTask: async request => request.operation === "repo.read"
  });

  assert.equal(result.ok, true);
  assert.equal(result.adapter_version, KRATT_STEEL_ADAPTER_VERSION);
  assert.equal(result.task.protocol_version, STEEL_PROTOCOL_VERSION);
  assert.equal(result.task.task_id, "inventory-17");
  assert.equal(result.correlation_id, "inventory-17");
  assert.equal(result.task.agent_id, "FORGE-002");
  assert.deepEqual(result.task.allowed_actions, ["repo:map-tree"]);
  assert.ok(result.task.forbidden_actions.includes("repo:write"));
});

test("fails closed when KRATT authorization is missing, denied, or throws", async () => {
  assert.equal((await mapKrattTaskToSteel(task(), { route: route() })).reason,
    "KRATT_AUTHORIZATION_UNAVAILABLE");
  assert.equal((await mapKrattTaskToSteel(task(), {
    route: route(), authorizeTask: async () => false
  })).reason, "KRATT_AUTHORIZATION_DENIED");
  assert.equal((await mapKrattTaskToSteel(task(), {
    route: route(), authorizeTask: async () => { throw new Error("private detail"); }
  })).reason, "KRATT_AUTHORIZATION_DENIED");
});

test("rejects malformed KRATT tasks and unsupported task IDs", async () => {
  assert.equal((await mapKrattTaskToSteel({ ...task(), unexpected: true }, {
    route: route(), authorizeTask: async () => true
  })).reason, "KRATT_TASK_INVALID");

  assert.equal((await mapKrattTaskToSteel(task({ task_id: "Inventory-17" }), {
    route: route(), authorizeTask: async () => true
  })).reason, "TASK_ID_NOT_STEEL_COMPATIBLE");
});

test("rejects non-read operations and non-repository targets", async () => {
  assert.equal((await mapKrattTaskToSteel(task({ action: "repo.write" }), {
    route: route(), authorizeTask: async () => true
  })).reason, "UNSUPPORTED_KRATT_OPERATION");

  assert.equal((await mapKrattTaskToSteel(task({
    target: { resource_type: "file", resource_id: "example/project" }
  }), { route: route(), authorizeTask: async () => true })).reason,
  "UNSUPPORTED_KRATT_OPERATION");
});

test("rejects main, malformed routes, path traversal, and route/target mismatch", async () => {
  const options = { authorizeTask: async () => true };

  assert.equal((await mapKrattTaskToSteel(task(), {
    ...options, route: route({ branch: "main" })
  })).reason, "STEEL_ROUTE_INVALID_OR_OUT_OF_SCOPE");

  assert.equal((await mapKrattTaskToSteel(task(), {
    ...options, route: route({ scope: ["../secrets"] })
  })).reason, "STEEL_ROUTE_INVALID_OR_OUT_OF_SCOPE");

  assert.equal((await mapKrattTaskToSteel(task(), {
    ...options, route: route({ repository: "other/project" })
  })).reason, "STEEL_ROUTE_INVALID_OR_OUT_OF_SCOPE");

  assert.equal((await mapKrattTaskToSteel(task(), {
    ...options, route: route({ required_evidence: [] })
  })).reason, "STEEL_ROUTE_INVALID_OR_OUT_OF_SCOPE");
});

test("does not copy arbitrary KRATT constraints into the STEEL payload", async () => {
  const result = await mapKrattTaskToSteel(task({
    constraints: { api_token: "do-not-forward-this-value" }
  }), {
    route: route(),
    authorizeTask: async () => true
  });

  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.task);
  assert.equal(serialized.includes("api_token"), false);
  assert.equal(serialized.includes("do-not-forward-this-value"), false);
  assert.equal(serialized.includes("not-forwarded"), false);
});
