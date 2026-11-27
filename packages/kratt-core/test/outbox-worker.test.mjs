import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxWorker } from "../src/outbox-worker.mjs";

function item(id, provider = "provider-a") {
  return {
    outbox_id: "outbox." + id,
    idempotency_key: "kratt:key:" + id.padEnd(64, "a").slice(0, 64),
    provider,
    payload: { task_id: "task." + id, data: { id } },
    lease_token: "lease-token-" + id + "-0123456789",
    attempts: 1,
  };
}

function fakeStore(items) {
  const calls = { claims: [], finishes: [], retries: [] };
  return {
    calls,
    async claimOutbox(input) {
      calls.claims.push(input);
      return items;
    },
    async finishOutbox(input) {
      calls.finishes.push(input);
      return { ok: true };
    },
    async retryOutbox(input) {
      calls.retries.push(input);
      return { ok: true, terminal: false, retry_at: "2026-11-27T12:00:00.000Z" };
    },
  };
}

test("runs provider calls with a bounded concurrency ceiling and stable result order", async () => {
  const store = fakeStore([item("1"), item("2"), item("3"), item("4")]);
  let active = 0;
  let peak = 0;
  const worker = createOutboxWorker({
    store,
    workerId: "worker.test",
    actorId: "actor.test",
    concurrency: 2,
    adapters: {
      "provider-a": {
        async dispatch({ payload, idempotencyKey }) {
          assert.equal(typeof idempotencyKey, "string");
          active += 1;
          peak = Math.max(peak, active);
          const delay = payload.data.id === "1" ? 20 : 5;
          await new Promise((resolve) => setTimeout(resolve, delay));
          active -= 1;
          return { status: "accepted" };
        },
      },
    },
  });

  const result = await worker.runOnce({ limit: 4, leaseSeconds: 45 });

  assert.equal(result.claimed, 4);
  assert.deepEqual(result.results.map((entry) => entry.outbox_id), [
    "outbox.1", "outbox.2", "outbox.3", "outbox.4",
  ]);
  assert.equal(peak, 2);
  assert.equal(result.metrics.maxInFlight, 2);
  assert.equal(result.metrics.concurrency, 2);
  assert.equal(result.metrics.recorded, 4);
  assert.equal(store.calls.finishes.length, 4);
  assert.equal(store.calls.retries.length, 0);
  assert.deepEqual(store.calls.claims, [{
    workerId: "worker.test", limit: 4, leaseSeconds: 45,
  }]);
});

test("isolates provider failures and schedules a bounded retry", async () => {
  const store = fakeStore([item("ok"), item("fail")]);
  const worker = createOutboxWorker({
    store,
    workerId: "worker.test",
    actorId: "actor.test",
    concurrency: 2,
    maxAttempts: 5,
    adapters: {
      "provider-a": {
        async dispatch({ payload }) {
          if (payload.data.id === "fail") throw new Error("provider unavailable");
          return { status: "completed" };
        },
      },
    },
  });

  const result = await worker.runOnce();
  assert.deepEqual(result.results.map((entry) => entry.status), [
    "RECORDED", "RETRY_SCHEDULED",
  ]);
  assert.equal(store.calls.retries.length, 1);
  assert.equal(store.calls.retries[0].outboxId, "outbox.fail");
  assert.equal(store.calls.retries[0].errorCode, "PROVIDER_DISPATCH_FAILED");
  assert.equal(store.calls.retries[0].maxAttempts, 5);
});

test("does not turn a lost outbox lease into a successful result", async () => {
  const store = fakeStore([item("1")]);
  store.finishOutbox = async () => ({ ok: false, reason: "LEASE_LOST" });
  const worker = createOutboxWorker({
    store,
    workerId: "worker.test",
    actorId: "actor.test",
    adapters: {
      "provider-a": { async dispatch() { return { status: "accepted" }; } },
    },
  });
  const result = await worker.runOnce();
  assert.equal(result.results[0].status, "LEASE_LOST");
  assert.equal(result.metrics.leaseLost, 1);
});

test("rejects invalid limits and getter-backed adapter registries", async () => {
  const store = fakeStore([]);
  const common = {
    store,
    workerId: "worker.test",
    actorId: "actor.test",
    adapters: {},
  };
  assert.throws(() => createOutboxWorker({ ...common, concurrency: 0 }), /OUTBOX_CONCURRENCY_INVALID/);
  assert.throws(() => createOutboxWorker({ ...common, concurrency: 33 }), /OUTBOX_CONCURRENCY_INVALID/);
  assert.throws(() => createOutboxWorker({ ...common, maxAttempts: 0 }), /OUTBOX_MAX_ATTEMPTS_INVALID/);

  const getters = {};
  Object.defineProperty(getters, "provider-a", {
    enumerable: true,
    get() { throw new Error("must not execute a registry getter"); },
  });
  assert.throws(() => createOutboxWorker({ ...common, adapters: getters }), /OUTBOX_ADAPTER_INVALID/);
  const worker = createOutboxWorker(common);
  await assert.rejects(worker.runOnce({ limit: 101 }), /OUTBOX_CLAIM_OPTIONS_INVALID/);
});
