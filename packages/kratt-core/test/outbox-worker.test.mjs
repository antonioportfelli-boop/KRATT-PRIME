import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxWorker } from "../src/outbox-worker.mjs";
import { createSecurityTelemetry } from "../src/security-telemetry.mjs";

const baseItem = Object.freeze({
  outbox_id: "outbox-1",
  provider: "mock-provider",
  idempotency_key: "idempotency-1",
  lease_token: "lease-1",
  payload: { task: { task_id: "task-outbox-1" } }
});

function createFixture({ adapter, finished = { ok: true }, telemetry } = {}) {
  const calls = { claim: [], finish: [], retry: [] };
  const store = {
    async claimOutbox(input) {
      calls.claim.push(input);
      return [baseItem];
    },
    async finishOutbox(input) {
      calls.finish.push(input);
      return finished;
    },
    async retryOutbox(input) {
      calls.retry.push(input);
      return { ok: true, status: "RETRY_WAIT" };
    }
  };
  const adapters = adapter === undefined ? { "mock-provider": { async dispatch() { return { status: "completed" }; } } }
    : { "mock-provider": adapter };
  const worker = createOutboxWorker({ store, adapters, workerId: "worker-1", actorId: "system-1", telemetry });
  return { worker, calls };
}

test("outbox worker emits correlated completion after durable outcome recording", async () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: event => events.push(event) });
  const fixture = createFixture({ telemetry });
  const result = await fixture.worker.runOnce({ limit: 1 });
  assert.deepEqual(result, { claimed: 1, results: [{ outbox_id: "outbox-1", status: "RECORDED" }] });
  assert.equal(fixture.calls.finish.length, 1);
  assert.equal(fixture.calls.finish[0].taskId, "task-outbox-1");
  assert.equal(events.some(event => event.name === "dispatch.completed" &&
    event.outcome === "completed" && event.correlationId === "task-outbox-1"), true);
  assert.equal(telemetry.snapshot().latency.length, 1);
});

test("outbox worker records bounded provider failure and preserves retry behavior", async () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: event => events.push(event) });
  const fixture = createFixture({
    telemetry,
    adapter: { async dispatch() { throw new Error("private provider error"); } }
  });
  const result = await fixture.worker.runOnce();
  assert.equal(result.results[0].status, "RETRY_SCHEDULED");
  assert.equal(fixture.calls.retry.length, 1);
  assert.equal(events.some(event => event.name === "dispatch.failed" &&
    event.reason === "PROVIDER_DISPATCH_FAILED" && event.correlationId === "task-outbox-1"), true);
  assert.equal(JSON.stringify(events).includes("private provider error"), false);
});

test("missing adapter is retried and reported without disclosing task payload", async () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: event => events.push(event) });
  const fixture = createFixture({ telemetry, adapter: null });
  const result = await fixture.worker.runOnce();
  assert.equal(result.results[0].status, "RETRY_SCHEDULED");
  assert.equal(fixture.calls.retry[0].errorCode, "PROVIDER_ADAPTER_UNAVAILABLE");
  assert.equal(events.some(event => event.reason === "PROVIDER_ADAPTER_UNAVAILABLE"), true);
  assert.equal(Object.hasOwn(events[0] ?? {}, "payload"), false);
});

test("invalid provider receipt is durably failed and emits dispatch.failed", async () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: event => events.push(event) });
  const fixture = createFixture({ telemetry, adapter: { async dispatch() { return { status: "unknown" }; } } });
  const result = await fixture.worker.runOnce();
  assert.equal(result.results[0].status, "RECORDED");
  assert.equal(fixture.calls.finish[0].outcome.status, "FAILED");
  assert.equal(events.some(event => event.name === "dispatch.failed" &&
    event.reason === "INVALID_PROVIDER_RESULT"), true);
});

test("stale outbox lease emits fencing telemetry and never reports completion", async () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: event => events.push(event) });
  const fixture = createFixture({ telemetry, finished: { ok: false, reason: "LEASE_LOST" } });
  const result = await fixture.worker.runOnce();
  assert.equal(result.results[0].status, "LEASE_LOST");
  assert.equal(events.some(event => event.name === "lease.fenced" &&
    event.reason === "OUTBOX_LEASE_LOST" && event.correlationId === "task-outbox-1"), true);
  assert.equal(events.some(event => event.name === "dispatch.completed"), false);
});

test("outbox telemetry sink failure cannot change provider dispatch or durable result", async () => {
  const telemetry = createSecurityTelemetry({ sink: () => { throw new Error("sink down"); } });
  const fixture = createFixture({ telemetry });
  const result = await fixture.worker.runOnce();
  assert.equal(result.results[0].status, "RECORDED");
  assert.equal(fixture.calls.finish.length, 1);
  assert.equal(telemetry.snapshot().diagnostics.sinkFailures, 1);
});

test("outbox worker accepts operation without optional telemetry", async () => {
  const fixture = createFixture();
  const result = await fixture.worker.runOnce();
  assert.equal(result.results[0].status, "RECORDED");
});
