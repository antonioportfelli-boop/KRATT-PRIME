import { types as utilTypes } from "node:util";
import { performance } from "node:perf_hooks";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const PROVIDER = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_CONCURRENCY = 32;

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function dataValue(value, key) {
  if (!isPlainRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && descriptor.enumerable
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAdapters(adapters) {
  if (!isPlainRecord(adapters)) throw new TypeError("OUTBOX_ADAPTER_REGISTRY_REQUIRED");
  const registry = new Map();
  let keys;
  try {
    keys = Reflect.ownKeys(adapters);
  } catch {
    throw new TypeError("OUTBOX_ADAPTER_REGISTRY_INVALID");
  }
  for (const key of keys) {
    if (typeof key !== "string" || !PROVIDER.test(key)) {
      throw new TypeError("OUTBOX_ADAPTER_PROVIDER_INVALID");
    }
    const adapter = dataValue(adapters, key);
    if (!isPlainRecord(adapter)) throw new TypeError("OUTBOX_ADAPTER_INVALID");
    const dispatch = dataValue(adapter, "dispatch");
    if (typeof dispatch !== "function") {
      throw new TypeError("OUTBOX_ADAPTER_DISPATCH_REQUIRED");
    }
    registry.set(key, dispatch);
  }
  return registry;
}

function taskIdFromPayload(payload) {
  if (!isPlainRecord(payload)) return undefined;
  const direct = dataValue(payload, "task_id");
  if (typeof direct === "string" && IDENTIFIER.test(direct)) return direct;
  const task = dataValue(payload, "task");
  const nested = dataValue(task, "task_id");
  return typeof nested === "string" && IDENTIFIER.test(nested) ? nested : undefined;
}

function normalizeClaim(item) {
  if (!isPlainRecord(item)) return null;
  const outboxId = dataValue(item, "outbox_id");
  const idempotencyKey = dataValue(item, "idempotency_key");
  const provider = dataValue(item, "provider");
  const payload = dataValue(item, "payload");
  const leaseToken = dataValue(item, "lease_token");
  if (typeof outboxId !== "string" || !IDENTIFIER.test(outboxId) ||
      typeof idempotencyKey !== "string" || idempotencyKey.length < 8 ||
      idempotencyKey.length > 256 ||
      typeof provider !== "string" || !PROVIDER.test(provider) ||
      typeof leaseToken !== "string" || leaseToken.length < 16 ||
      leaseToken.length > 256 ||
      (payload !== null && typeof payload === "object" &&
        (utilTypes.isProxy(payload) || (!Array.isArray(payload) && !isPlainRecord(payload))))) {
    return null;
  }
  return Object.freeze({
    outboxId,
    idempotencyKey,
    provider,
    payload,
    leaseToken,
    taskId: taskIdFromPayload(payload),
  });
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Bounded at-least-once outbox worker.
 *
 * Provider calls run with a fixed concurrency ceiling. Results retain claim
 * order even when provider calls finish out of order. Every delivery reuses
 * its durable idempotency key. A lost lease is never reported as success.
 *
 * Provider adapters remain responsible for enforcing their own network
 * timeout and honoring the stable idempotency key across retries.
 */
export function createOutboxWorker({
  store,
  adapters,
  workerId,
  actorId,
  maxAttempts = 8,
  concurrency = 4,
} = {}) {
  if (!store || typeof store.claimOutbox !== "function" ||
      typeof store.finishOutbox !== "function" ||
      typeof store.retryOutbox !== "function") {
    throw new TypeError("OUTBOX_STORE_REQUIRED");
  }
  if (typeof workerId !== "string" || !IDENTIFIER.test(workerId) ||
      typeof actorId !== "string" || !IDENTIFIER.test(actorId)) {
    throw new TypeError("OUTBOX_WORKER_IDENTITY_REQUIRED");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32) {
    throw new TypeError("OUTBOX_MAX_ATTEMPTS_INVALID");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
      concurrency > MAX_CONCURRENCY) {
    throw new TypeError("OUTBOX_CONCURRENCY_INVALID");
  }

  const registry = normalizeAdapters(adapters);

  async function retry(item, errorCode) {
    try {
      const result = await store.retryOutbox({
        outboxId: item.outboxId,
        leaseToken: item.leaseToken,
        errorCode,
        maxAttempts,
      });
      return result && result.ok === true
        ? { outbox_id: item.outboxId, status: "RETRY_SCHEDULED", retry: result }
        : { outbox_id: item.outboxId, status: "RETRY_RECORD_FAILED" };
    } catch {
      return { outbox_id: item.outboxId, status: "RETRY_RECORD_FAILED" };
    }
  }

  async function processItem(rawItem) {
    const item = normalizeClaim(rawItem);
    if (!item) return { outbox_id: null, status: "CLAIM_INVALID" };

    if (!Object.hasOwn(adapters,item.provider)) return retry(item, "PROVIDER_ADAPTER_UNAVAILABLE");

    const dispatch = registry.get(item.provider);
    if (!dispatch) return retry(item, "PROVIDER_ADAPTER_UNAVAILABLE");

    let providerResult;
    try {
      providerResult = await dispatch(Object.freeze({
        payload: item.payload,
        idempotencyKey: item.idempotencyKey,
      }));
    } catch {
      return retry(item, "PROVIDER_DISPATCH_FAILED");
    }

    const providerStatus = dataValue(providerResult, "status");
    const accepted = providerStatus === "accepted" || providerStatus === "completed";

    try {
      const finished = await store.finishOutbox({
        outboxId: item.outboxId,
        leaseToken: item.leaseToken,
        actorId,
        taskId: item.taskId,
        outcome: accepted
          ? { status: "COMPLETED", audit_result: { status: providerStatus } }
          : { status: "FAILED", audit_result: { status: "invalid_result" } },
      });
      if (finished && finished.ok === true) {
        return {
          outbox_id: item.outboxId,
          status: accepted ? "RECORDED" : "RECORDED_FAILED_RESULT",
        };
      }
      if (finished && finished.reason === "LEASE_LOST") {
        return { outbox_id: item.outboxId, status: "LEASE_LOST" };
      }
      return { outbox_id: item.outboxId, status: "FINISH_REJECTED" };
    } catch {
      // A lost reply after commit is safe: the lease token prevents a second
      // finalization, and the stable provider idempotency key protects retries.
      return retry(item, "OUTBOX_FINISH_FAILED");
    }
  }

  async function runOnce({ limit = 10, leaseSeconds = 60 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 ||
        leaseSeconds > 900) {
      throw new TypeError("OUTBOX_CLAIM_OPTIONS_INVALID");
    }

    const startedAt = performance.now();
    const claimed = await store.claimOutbox({ workerId, limit, leaseSeconds });
    if (!Array.isArray(claimed)) throw new TypeError("OUTBOX_CLAIM_RESULT_INVALID");

    const results = new Array(claimed.length);
    let cursor = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    async function consume() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= claimed.length) return;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          results[index] = await processItem(claimed[index]);
        } catch {
          results[index] = { outbox_id: null, status: "WORKER_ITEM_FAILED" };
        } finally {
          inFlight -= 1;
        }
      }
    }

    const poolSize = Math.min(concurrency, claimed.length);
    await Promise.all(Array.from({ length: poolSize }, () => consume()));

    const durationMs = Math.max(0, performance.now() - startedAt);
    const recorded = results.filter((item) =>
      item.status === "RECORDED" || item.status === "RECORDED_FAILED_RESULT"
    ).length;
    const retryScheduled = results.filter((item) =>
      item.status === "RETRY_SCHEDULED"
    ).length;
    const leaseLost = results.filter((item) => item.status === "LEASE_LOST").length;
    const processedPerSecond = durationMs > 0
      ? round((results.length / durationMs) * 1000, 2)
      : 0;

    return Object.freeze({
      claimed: claimed.length,
      results: Object.freeze(results),
      metrics: Object.freeze({
        concurrency,
        maxInFlight,
        durationMs: round(durationMs),
        processedPerSecond,
        recorded,
        retryScheduled,
        leaseLost,
      }),
    });
  }

  return Object.freeze({ runOnce });
}
