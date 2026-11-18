import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizedDispatchRuntime } from "../src/authorized-dispatch.mjs";
import { KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";

const at = "2026-11-18T15:00:00.000Z";
const task = (overrides = {}) => ({
  schema_version: KRATT_SCHEMA_VERSION,
  task_id: "task-dispatch-01",
  actor: "operator-01",
  action: "repository.read",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
  constraints: { provider: "github" },
  required_evidence: [],
  created_at: at,
  requested_authority: ["repository.read"],
  status: "PENDING",
  ...overrides,
});
const allowed = {
  schema_version: KRATT_SCHEMA_VERSION,
  decision_id: "decision-01",
  task_id: "task-dispatch-01",
  decision: "ALLOW",
  reasons: ["ALL_CONDITIONS_SATISFIED"],
  evidence_ids: [],
  evaluated_at: at,
};

function setup({ decision = allowed, commit = true, appendDecision = true, appendOutcome = true, dispatch } = {}) {
  const events = [];
  const claimed = new Set();
  const calls = [];
  const commandStore = {
    async appendDecision(record) {
      events.push(["decision", record]);
      return appendDecision;
    },
    async commitAuthorizedIntent({ idempotencyKey, taskId, record }) {
      calls.push(["commit", taskId, idempotencyKey]);
      if (!commit || claimed.has(idempotencyKey)) return false;
      claimed.add(idempotencyKey);
      events.push(["intent", record]);
      return true;
    },
    async appendOutcome({ idempotencyKey, record }) {
      calls.push(["outcome", idempotencyKey]);
      events.push(["outcome", record]);
      return appendOutcome;
    },
  };
  const adapter = {
    async dispatch(input) {
      calls.push(["dispatch", input.idempotencyKey]);
      return dispatch ? dispatch(input) : { status: "completed", provider_reference: "mock-123" };
    },
  };
  const runtime = createAuthorizedDispatchRuntime({
    authorizationRuntime: { evaluate: () => decision },
    authenticatePrincipal: async () => ({ id: "operator-01", active: true }),
    loadTrustedContext: async () => ({ trusted: true }),
    loadEvidence: async () => [],
    commandStore,
    providerAdapters: { github: adapter },
    now: () => Date.parse(at),
  });
  return { runtime, events, calls, claimed };
}

test("writes a durable intent before dispatch and a durable outcome after it", async () => {
  const { runtime, events, calls } = setup();
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls.map(x => x[0]), ["commit", "dispatch", "outcome"]);
  assert.deepEqual(events.map(x => x[0]), ["intent", "outcome"]);
  assert.equal(events[0][1].event_type, "dispatch.intent_committed");
  assert.equal(events[1][1].event_type, "dispatch.completed");
  assert.equal(calls[0][2], calls[1][1]);
});

test("denies a task whose actor differs from the authenticated principal", async () => {
  const { runtime, calls, events } = setup();
  const result = await runtime.execute({ principal: "session", task: task({ actor: "attacker" }) });
  assert.equal(result.reason, "TASK_ACTOR_MISMATCH");
  assert.deepEqual(calls, []);
  assert.equal(events[0][1].event_type, "authorization.denied");
});

test("never dispatches when authentication fails", async () => {
  const { runtime } = setup();
  const failing = createAuthorizedDispatchRuntime({
    authorizationRuntime: { evaluate: () => allowed },
    authenticatePrincipal: async () => { throw new Error("invalid session"); },
    loadTrustedContext: async () => ({}),
    loadEvidence: async () => [],
    commandStore: { appendDecision: async () => true, commitAuthorizedIntent: async () => true, appendOutcome: async () => true },
    providerAdapters: { github: { dispatch: async () => { throw new Error("must not run"); } } },
    now: () => Date.parse(at),
  });
  assert.equal((await failing.execute({ principal: "bad", task: task() })).status, "DENIED");
  assert.equal((await runtime.execute({ principal: "session", task: task() })).status, "COMPLETED");
});

test("records policy denials and never calls provider", async () => {
  const denied = { ...allowed, decision: "DENY", reasons: ["MISSING_TRUSTED_AUTHORIZATION"] };
  const { runtime, calls, events } = setup({ decision: denied });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.status, "DENIED");
  assert.equal(result.reason, "MISSING_TRUSTED_AUTHORIZATION");
  assert.deepEqual(calls, []);
  assert.equal(events[0][1].event_type, "authorization.denied");
});

test("does not dispatch when durable intent commit fails", async () => {
  const { runtime, calls, events } = setup({ commit: false });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.reason, "INTENT_NOT_COMMITTED_OR_DUPLICATE");
  assert.deepEqual(calls.map(x => x[0]), ["commit"]);
  assert.deepEqual(events, []);
});

test("prevents duplicate intent dispatch through the durable idempotency claim", async () => {
  const { runtime, calls } = setup();
  const first = await runtime.execute({ principal: "session", task: task() });
  const second = await runtime.execute({ principal: "session", task: task() });
  assert.equal(first.status, "COMPLETED");
  assert.equal(second.reason, "INTENT_NOT_COMMITTED_OR_DUPLICATE");
  assert.equal(calls.filter(x => x[0] === "dispatch").length, 1);
});

test("does not dispatch if trusted context or evidence cannot be loaded", async () => {
  const { events, calls } = setup();
  const runtime = createAuthorizedDispatchRuntime({
    authorizationRuntime: { evaluate: () => allowed },
    authenticatePrincipal: async () => ({ id: "operator-01", active: true }),
    loadTrustedContext: async () => { throw new Error("policy store offline"); },
    loadEvidence: async () => [],
    commandStore: { appendDecision: async record => { events.push(record); return true; }, commitAuthorizedIntent: async () => true, appendOutcome: async () => true },
    providerAdapters: { github: { dispatch: async () => { calls.push("dispatch"); return { status: "completed" }; } } },
    now: () => Date.parse(at),
  });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.reason, "TRUSTED_INPUT_UNAVAILABLE");
  assert.deepEqual(calls, []);
  assert.equal(events[0].event_type, "authorization.denied");
});

test("fails closed when the provider adapter is missing", async () => {
  const { events } = setup();
  const runtime = createAuthorizedDispatchRuntime({
    authorizationRuntime: { evaluate: () => allowed },
    authenticatePrincipal: async () => ({ id: "operator-01", active: true }),
    loadTrustedContext: async () => ({}),
    loadEvidence: async () => [],
    commandStore: { appendDecision: async record => { events.push(record); return true; }, commitAuthorizedIntent: async () => true, appendOutcome: async () => true },
    providerAdapters: {},
    now: () => Date.parse(at),
  });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.reason, "PROVIDER_ADAPTER_UNAVAILABLE");
  assert.equal(events[0].event_type, "authorization.denied");
});

test("reports provider failure and records its outcome", async () => {
  const { runtime, events } = setup({ dispatch: async () => { throw new Error("provider unavailable"); } });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.status, "FAILED");
  assert.equal(events.at(-1)[1].event_type, "dispatch.failed");
});

test("does not claim completion when outcome audit persistence fails", async () => {
  const { runtime } = setup({ appendOutcome: false });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.status, "OUTCOME_UNRECORDED");
  assert.equal(result.dispatched, true);
});

test("rejects malformed provider results before treating them as completed", async () => {
  const { runtime, events } = setup({ dispatch: async () => ({ status: "completed", access_token: "secret" }) });
  const result = await runtime.execute({ principal: "session", task: task() });
  assert.equal(result.status, "FAILED");
  assert.equal(events.at(-1)[1].result.reason, "PROVIDER_DISPATCH_FAILED_OR_INVALID_RESULT");
});

test("requires durable storage and trusted authentication dependencies", () => {
  assert.throws(() => createAuthorizedDispatchRuntime({}), /TRUSTED_AUTHORIZATION_RUNTIME_REQUIRED/);
});
