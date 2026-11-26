import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxWorker } from "../src/outbox-worker.mjs";

function fixture({
  begin = { ok: true, duplicate: false },
  dispatch = async () => ({ status: "accepted" }),
  finish = { ok: true },
  retry = { ok: true, status: "RECONCILE", reconciliation_required: true },
  adapters = true
} = {}) {
  const calls = [];
  const item = {
    outbox_id: "outbox-1",
    idempotency_key: "kratt:task-1:" + "a".repeat(64),
    provider: "provider-1",
    task_id: "task-1",
    payload: { task_id: "task-1", action: "write" },
    lease_token: "lease-token-00000001",
    delivery_attempt_sequence: 4
  };
  const store = {
    async claimOutbox(input) {
      calls.push(["claim", input]);
      return [item];
    },
    async beginOutboxDelivery(input) {
      calls.push(["begin", input]);
      if (begin instanceof Error) throw begin;
      if (typeof begin === "function") return begin(input);
      return begin;
    },
    async finishOutbox(input) {
      calls.push(["finish", input]);
      if (finish instanceof Error) throw finish;
      return finish;
    },
    async retryOutbox(input) {
      calls.push(["retry", input]);
      if (retry instanceof Error) throw retry;
      return retry;
    }
  };
  const registry = adapters ? {
    "provider-1": {
      async dispatch(input) {
        calls.push(["dispatch", input]);
        if (dispatch instanceof Error) throw dispatch;
        return dispatch(input);
      }
    }
  } : {};
  return { calls, item, store, registry };
}

test("worker requires the durable delivery-start fence at composition time", () => {
  assert.throws(() => createOutboxWorker({
    store: { claimOutbox() {}, finishOutbox() {}, retryOutbox() {} },
    adapters: {},
    workerId: "worker-1",
    actorId: "operator-1"
  }), /OUTBOX_STORE_AND_DELIVERY_FENCE_REQUIRED/);
});

test("worker obtains delivery-start fence before invoking the provider", async () => {
  const f = fixture();
  const worker = createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  });
  const result = await worker.runOnce();
  assert.deepEqual(f.calls.map(call => call[0]), ["claim", "begin", "dispatch", "finish"]);
  assert.deepEqual(f.calls[1][1], { outboxId: "outbox-1", leaseToken: "lease-token-00000001" });
  assert.equal(f.calls[2][1].idempotencyKey, f.item.idempotency_key);
  assert.equal(f.calls[2][1].deliveryAttempt, 4);
  assert.equal(f.calls[3][1].taskId, "task-1");
  assert.equal(result.results[0].status, "RECORDED");
  assert.equal(result.results[0].dispatched, true);
});

test("cancelled task at the delivery fence never invokes the provider or retries", async () => {
  const f = fixture({ begin: { ok: false, reason: "TASK_CANCELLED" } });
  const result = await createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  }).runOnce();
  assert.deepEqual(f.calls.map(call => call[0]), ["claim", "begin"]);
  assert.equal(result.results[0].status, "CANCELLED");
  assert.equal(result.results[0].dispatched, false);
});

test("lost lease or uncertain prior delivery fails closed without another provider call", async () => {
  for (const begin of [
    { ok: false, reason: "LEASE_LOST" },
    { ok: false, reason: "DELIVERY_RECONCILIATION_REQUIRED" },
    { ok: true, duplicate: true }
  ]) {
    const f = fixture({ begin });
    const result = await createOutboxWorker({
      store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
    }).runOnce();
    assert.equal(f.calls.some(call => call[0] === "dispatch"), false);
    assert.equal(f.calls.some(call => call[0] === "finish" || call[0] === "retry"), false);
    assert.equal(result.results[0].dispatched, false);
  }
});

test("delivery fence dependency failure never falls through to a provider call", async () => {
  const f = fixture({ begin: new Error("database unavailable") });
  const result = await createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  }).runOnce();
  assert.deepEqual(f.calls.map(call => call[0]), ["claim", "begin"]);
  assert.equal(result.results[0].status, "DELIVERY_START_UNAVAILABLE");
  assert.equal(result.results[0].dispatched, false);
});

test("provider timeout after the fence goes to reconciliation, not blind retry", async () => {
  const f = fixture({ dispatch: new Error("simulated provider timeout") });
  const result = await createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  }).runOnce();
  const retry = f.calls.find(call => call[0] === "retry")[1];
  assert.equal(retry.retrySafety, "UNKNOWN");
  assert.equal(retry.errorCode, "PROVIDER_DISPATCH_FAILED");
  assert.equal(result.results[0].status, "RECONCILE_REQUIRED");
  assert.equal(result.results[0].dispatched, true);
});

test("invalid provider result after dispatch is reconciled rather than marked completed", async () => {
  const f = fixture({ dispatch: async () => ({ status: "maybe" }) });
  const result = await createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  }).runOnce();
  const retry = f.calls.find(call => call[0] === "retry")[1];
  assert.equal(retry.retrySafety, "UNKNOWN");
  assert.equal(retry.errorCode, "PROVIDER_RESULT_INVALID");
  assert.equal(f.calls.some(call => call[0] === "finish"), false);
  assert.equal(result.results[0].status, "RECONCILE_REQUIRED");
});

test("provider accepted but outcome persistence failed is never reported as recorded", async () => {
  const f = fixture({ finish: { ok: false, reason: "LEASE_LOST" } });
  const result = await createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  }).runOnce();
  assert.equal(result.results[0].status, "OUTCOME_UNRECORDED");
  assert.equal(result.results[0].dispatched, true);
  assert.equal(result.results[0].reconciliation_required, true);
  assert.equal(f.calls.some(call => call[0] === "retry"), false);
});

test("missing adapter is retried before the delivery fence and causes no side effect", async () => {
  const f = fixture({ adapters: false });
  const result = await createOutboxWorker({
    store: f.store, adapters: f.registry, workerId: "worker-1", actorId: "operator-1"
  }).runOnce();
  assert.deepEqual(f.calls.map(call => call[0]), ["claim", "retry"]);
  const retry = f.calls.find(call => call[0] === "retry")[1];
  assert.equal(retry.errorCode, "PROVIDER_ADAPTER_UNAVAILABLE");
  assert.equal(retry.retrySafety, "UNKNOWN");
  assert.equal(result.results[0].status, "RECONCILE_REQUIRED");
});
