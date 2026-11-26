/**
 * At-least-once worker. Provider adapters MUST honor stable idempotency keys.
 * A durable delivery-start fence is mandatory before any external side effect.
 */
export function createOutboxWorker({ store, adapters, workerId, actorId, maxAttempts = 8 } = {}) {
  if (!store || typeof store.claimOutbox !== "function" ||
      typeof store.beginOutboxDelivery !== "function" ||
      typeof store.finishOutbox !== "function" ||
      typeof store.retryOutbox !== "function") {
    throw new TypeError("OUTBOX_STORE_AND_DELIVERY_FENCE_REQUIRED");
  }
  if (!adapters || Object.getPrototypeOf(adapters) !== Object.prototype)
    throw new TypeError("OUTBOX_ADAPTER_REGISTRY_REQUIRED");
  if (typeof workerId !== "string" || !workerId ||
      typeof actorId !== "string" || !actorId) {
    throw new TypeError("OUTBOX_WORKER_IDENTITY_REQUIRED");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32)
    throw new TypeError("OUTBOX_MAX_ATTEMPTS_INVALID");

  async function runOnce({ limit = 10, leaseSeconds = 60 } = {}) {
    const claimed = await store.claimOutbox({ workerId, limit, leaseSeconds });
    const results = [];

    for (const item of claimed) {
      const adapter = Object.hasOwn(adapters, item.provider) ? adapters[item.provider] : null;
      if (!adapter || typeof adapter.dispatch !== "function") {
        let retry;
        try {
          retry = await store.retryOutbox({
            outboxId: item.outbox_id,
            leaseToken: item.lease_token,
            workerId,
            errorCode: "PROVIDER_ADAPTER_UNAVAILABLE",
            maxAttempts,
            retrySafety: "UNKNOWN"
          });
        } catch {
          retry = { ok: false, reason: "RETRY_STATE_UNAVAILABLE" };
        }
        results.push({
          outbox_id: item.outbox_id,
          status: retry?.reconciliation_required ? "RECONCILE_REQUIRED" :
            retry?.ok ? "RETRY_SCHEDULED" : "RETRY_STATE_UNAVAILABLE",
          retry
        });
        continue;
      }

      // This is the cancellation/lease serialization boundary. Never dispatch
      // merely because claimOutbox returned a row.
      let started;
      try {
        started = await store.beginOutboxDelivery({
          outboxId: item.outbox_id,
          leaseToken: item.lease_token,
          workerId
        });
      } catch {
        results.push({
          outbox_id: item.outbox_id,
          status: "DELIVERY_START_UNAVAILABLE",
          dispatched: false
        });
        continue;
      }
      if (started?.ok !== true) {
        results.push({
          outbox_id: item.outbox_id,
          status: started?.reason === "TASK_CANCELLED" ? "CANCELLED" :
            started?.reason === "DELIVERY_RECONCILIATION_REQUIRED" ? "RECONCILE_REQUIRED" :
              started?.reason === "LEASE_LOST" ? "LEASE_LOST" :
                started?.reason === "LEASE_OWNER_MISMATCH" ? "LEASE_OWNER_MISMATCH" : "DELIVERY_START_DENIED",
          reason: started?.reason ?? "DELIVERY_START_DENIED",
          dispatched: false
        });
        continue;
      }
      // A duplicate start means this lease already crossed the side-effect fence.
      // It is not permission to invoke the provider again.
      if (started.duplicate === true) {
        results.push({
          outbox_id: item.outbox_id,
          status: "DELIVERY_ALREADY_STARTED",
          dispatched: false,
          reconciliation_required: true
        });
        continue;
      }

      let result;
      try {
        result = await adapter.dispatch({
          payload: item.payload,
          idempotencyKey: item.idempotency_key,
          deliveryAttempt: item.delivery_attempt_sequence
        });
      } catch {
        let retry;
        try {
          retry = await store.retryOutbox({
            outboxId: item.outbox_id,
            leaseToken: item.lease_token,
            workerId,
            errorCode: "PROVIDER_DISPATCH_FAILED",
            maxAttempts,
            retrySafety: "UNKNOWN"
          });
        } catch {
          retry = { ok: false, reason: "RETRY_STATE_UNAVAILABLE" };
        }
        results.push({
          outbox_id: item.outbox_id,
          status: retry?.reconciliation_required ? "RECONCILE_REQUIRED" :
            retry?.ok ? "RETRY_SCHEDULED" : "OUTCOME_UNRECORDED",
          retry,
          dispatched: true
        });
        continue;
      }

      const valid = result && typeof result === "object" &&
        !Array.isArray(result) && ["accepted", "completed"].includes(result.status);
      if (!valid) {
        let retry;
        try {
          retry = await store.retryOutbox({
            outboxId: item.outbox_id,
            leaseToken: item.lease_token,
            workerId,
            errorCode: "PROVIDER_RESULT_INVALID",
            maxAttempts,
            retrySafety: "UNKNOWN"
          });
        } catch {
          retry = { ok: false, reason: "RETRY_STATE_UNAVAILABLE" };
        }
        results.push({
          outbox_id: item.outbox_id,
          status: retry?.reconciliation_required ? "RECONCILE_REQUIRED" : "OUTCOME_UNRECORDED",
          retry,
          dispatched: true
        });
        continue;
      }

      let finished;
      try {
        finished = await store.finishOutbox({
          outboxId: item.outbox_id,
          leaseToken: item.lease_token,
          workerId,
          actorId,
          taskId: item.task_id ?? item.payload?.task?.task_id ?? item.payload?.task_id,
          outcome: { status: "COMPLETED", audit_result: { status: result.status } }
        });
      } catch {
        finished = { ok: false, reason: "OUTCOME_STORE_UNAVAILABLE" };
      }
      results.push({
        outbox_id: item.outbox_id,
        status: finished?.ok === true ? "RECORDED" : "OUTCOME_UNRECORDED",
        reason: finished?.ok === true ? undefined : finished?.reason ?? "OUTCOME_STORE_UNAVAILABLE",
        dispatched: true,
        reconciliation_required: finished?.ok !== true
      });
    }

    return { claimed: claimed.length, results };
  }

  return Object.freeze({ runOnce });
}
