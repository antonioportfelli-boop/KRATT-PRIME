import test from "node:test";
import assert from "node:assert/strict";
import { validateOperationTransition } from "../src/runtime-observatory.mjs";
import { createPhase11Wave10Integration } from "../src/phase11-wave10-integration.mjs";

const NOW = "2026-11-23T00:00:00.000Z";

function createObservabilityStore({ failStatus = null } = {}) {
  const events = [];
  const latest = new Map();
  return {
    events,
    store: {
      async append(event) {
        if (event.status === failStatus) return { ok: false, reason: "TEST_SINK_FAILURE" };
        const previous = latest.get(event.operation_id) ?? null;
        const transition = validateOperationTransition(previous, event);
        if (!transition.ok) return { ok: false, reason: transition.reason };
        latest.set(event.operation_id, event);
        events.push(structuredClone(event));
        return { ok: true };
      }
    }
  };
}

function createIdFactory() {
  let next = 0;
  return () => "testid-" + (++next).toString(16).padStart(8, "0");
}

function createEngine(overrides = {}) {
  const calls = [];
  const phaseEngine = {
    async propose(input) {
      calls.push(["propose", input]);
      return { ok: true, duplicate: false, run: { runId: "phase_run_001", requestId: input.requestId, status: "PLANNED" } };
    },
    async execute(input) {
      calls.push(["execute", input]);
      return { ok: true, run: { runId: input.runId, requestId: input.requestId, status: "READY_FOR_APPROVAL" } };
    },
    async commitApproved(input) {
      calls.push(["commitApproved", input]);
      return { ok: true, run: { runId: input.runId, status: "COMMITTED" }, commitSha: "a".repeat(40) };
    },
    ...overrides
  };
  return { phaseEngine, calls };
}

function createIntegration({ phaseEngine, observabilityStore, semanticPipeline, ...overrides }) {
  return createPhase11Wave10Integration({
    phaseEngine,
    observabilityStore,
    semanticPipeline,
    clock: () => NOW,
    makeId: createIdFactory(),
    environment: "test",
    capabilityState: "partial",
    ...overrides
  });
}

test("Phase 11 propose is wrapped by Wave 10 queued/running/succeeded events", async () => {
  const { phaseEngine, calls } = createEngine();
  const sink = createObservabilityStore();
  const integration = createIntegration({ phaseEngine, observabilityStore: sink.store });
  const result = await integration.propose({ requestId: "request-phase11" });

  assert.equal(result.ok, true);
  assert.equal(result.run.runId, "phase_run_001");
  assert.equal(result.observation.status, "succeeded");
  assert.equal(calls.length, 1);
  assert.deepEqual(sink.events.map(event => event.status), ["queued", "running", "succeeded"]);
  assert.equal(new Set(sink.events.map(event => event.operation_id)).size, 1);
  assert.equal(new Set(sink.events.map(event => event.correlation_id)).size, 1);
  assert.equal(sink.events[2].output_ref, "phase11/result/phase_run_001");
});

test("Phase 11 execution rejection becomes a failed observable operation", async () => {
  const { phaseEngine, calls } = createEngine({
    async execute() { return { ok: false, reason: "RUN_ALREADY_CLAIMED" }; }
  });
  const sink = createObservabilityStore();
  const integration = createIntegration({ phaseEngine, observabilityStore: sink.store });
  const result = await integration.execute({ runId: "phase_run_001", requestId: "request-phase11" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "RUN_ALREADY_CLAIMED");
  assert.equal(calls.length, 0);
  assert.deepEqual(sink.events.map(event => event.status), ["queued", "running", "failed"]);
});

test("observability queue failure prevents the Phase 11 side effect", async () => {
  let called = false;
  const { phaseEngine } = createEngine({
    async propose() { called = true; return { ok: true, run: { runId: "phase_run_002" } }; }
  });
  const sink = createObservabilityStore({ failStatus: "queued" });
  const integration = createIntegration({ phaseEngine, observabilityStore: sink.store });
  const result = await integration.propose({ requestId: "request-phase11" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "BLOCKED");
  assert.equal(called, false);
  assert.equal(sink.events.length, 0);
});

test("unrecorded post-commit telemetry is explicit and requires reconciliation", async () => {
  let commitCount = 0;
  const { phaseEngine } = createEngine({
    async commitApproved() {
      commitCount++;
      return { ok: true, run: { runId: "phase_run_003", status: "COMMITTED" }, commitSha: "b".repeat(40) };
    }
  });
  const sink = createObservabilityStore({ failStatus: "succeeded" });
  const integration = createIntegration({ phaseEngine, observabilityStore: sink.store });
  const result = await integration.commitApproved({ runId: "phase_run_003", requestId: "request-phase11", approval: {} });

  assert.equal(commitCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, "OUTCOME_UNRECORDED");
  assert.equal(result.sideEffectMayHaveCompleted, true);
  assert.equal(result.reason, "COMMIT_OUTCOME_UNRECORDED_RECONCILIATION_REQUIRED");
});

test("semantic pipeline is observed through the same Wave 10 contract", async () => {
  const { phaseEngine } = createEngine();
  const sink = createObservabilityStore();
  const semanticPipeline = {
    async run(input) {
      return { ok: true, status: "STORED", recordId: "semantic_record_01", requestId: input.requestId };
    }
  };
  const integration = createIntegration({ phaseEngine, observabilityStore: sink.store, semanticPipeline });
  const result = await integration.runSemanticPipeline({
    requestId: "request-semantic-01",
    principalId: "principal-01",
    source: {},
    context: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "STORED");
  assert.deepEqual(sink.events.map(event => event.status), ["queued", "running", "succeeded"]);
  assert.equal(sink.events[2].output_ref, "phase11/result/semantic_record_01");
});

test("missing semantic pipeline fails closed without fabricating an observable run", async () => {
  const { phaseEngine } = createEngine();
  const sink = createObservabilityStore();
  const integration = createIntegration({ phaseEngine, observabilityStore: sink.store });
  const result = await integration.runSemanticPipeline({ requestId: "request-semantic-02" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "SEMANTIC_PIPELINE_NOT_CONFIGURED");
  assert.equal(sink.events.length, 0);
});

test("invalid runtime metadata is rejected at composition time", () => {
  const { phaseEngine } = createEngine();
  const sink = createObservabilityStore();
  assert.throws(
    () => createIntegration({ phaseEngine, observabilityStore: sink.store, environment: "unknown" }),
    /PHASE11_WAVE10_RUNTIME_METADATA_INVALID/
  );
});
