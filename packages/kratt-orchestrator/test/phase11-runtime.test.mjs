import test from "node:test";
import assert from "node:assert/strict";
import { validateOperationTransition } from "../../kratt-core/src/runtime-observatory.mjs";
import { createPhase11Runtime } from "../src/phase11-runtime.mjs";

const NOW = "2026-11-23T00:00:00.000Z";

function phaseStore() {
  const runs = new Map();
  const events = [];
  const leases = new Set();
  return {
    runs,
    events,
    async findByIdempotencyKey(key) {
      return [...runs.values()].find(run => run.idempotencyKey === key) ?? null;
    },
    async createRun(run) {
      runs.set(run.runId, structuredClone(run));
      return structuredClone(run);
    },
    async getRun(id) {
      return structuredClone(runs.get(id) ?? null);
    },
    async updateRun(id, patch) {
      const current = runs.get(id);
      if (!current) return null;
      const next = { ...current, ...structuredClone(patch) };
      runs.set(id, next);
      return structuredClone(next);
    },
    async appendEvent(event) {
      events.push(structuredClone(event));
      return event;
    },
    async claimLease(id) {
      if (leases.has(id)) return false;
      leases.add(id);
      return "lease:" + id;
    },
    async releaseLease(id) {
      leases.delete(id);
    }
  };
}

function observabilityStore() {
  const events = [];
  const latest = new Map();
  return {
    events,
    async append(event) {
      const previous = latest.get(event.operation_id) ?? null;
      const checked = validateOperationTransition(previous, event);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      latest.set(event.operation_id, event);
      events.push(structuredClone(event));
      return { ok: true };
    }
  };
}

test("composition root exposes only Wave 10-observed Phase 11 methods", async () => {
  const phases = phaseStore();
  const telemetry = observabilityStore();
  const runtime = createPhase11Runtime({
    phaseStore: phases,
    observabilityStore: telemetry,
    phaseEngineOptions: {
      policyEvaluator: async request => ({
        decision: "ALLOW",
        requestId: request.requestId,
        decisionId: "policy:" + request.action,
        evaluatedAt: NOW
      })
    },
    clock: () => NOW,
    environment: "test"
  });

  for (const method of ["propose", "execute", "commitApproved", "runSemanticPipeline", "getRun", "watchEvents"]) {
    assert.equal(typeof runtime[method], "function", method);
  }
  assert.equal(Object.hasOwn(runtime, "engine"), false);

  const result = await runtime.propose({ requestId: "request-phase11" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PHASE_REQUEST_INVALID");
  assert.deepEqual(telemetry.events.map(event => event.status), ["queued", "running", "failed"]);
});

test("composition root rejects untrusted non-object engine configuration", () => {
  assert.throws(() => createPhase11Runtime({
    phaseStore: phaseStore(),
    observabilityStore: observabilityStore(),
    phaseEngineOptions: []
  }), /PHASE11_ENGINE_OPTIONS_INVALID/);
});

test("composition root requires a Wave 10 observability store", () => {
  assert.throws(() => createPhase11Runtime({
    phaseStore: phaseStore(),
    observabilityStore: null
  }), /WAVE10_OBSERVABILITY_STORE_REQUIRED/);
});
