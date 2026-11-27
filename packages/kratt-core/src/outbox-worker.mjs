import { performance } from "node:perf_hooks";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function taskCorrelationId(item) {
  const value = item?.payload?.task?.task_id ?? item?.payload?.task_id;
  return typeof value === "string" && ID.test(value) ? value : null;
}

/**
 * At-least-once worker. Provider adapters MUST honor stable idempotency keys.
 * Telemetry is optional and non-authoritative; the outbox store remains the
 * source of truth for durable intent and delivery outcome.
 */
export function createOutboxWorker({
  store,
  adapters,
  workerId,
  actorId,
  maxAttempts = 8,
  telemetry
} = {}) {
  if (!store || typeof store.claimOutbox !== "function" ||
      typeof store.finishOutbox !== "function" || typeof store.retryOutbox !== "function") {
    throw new TypeError("OUTBOX_STORE_REQUIRED");
  }
  if (!adapters || Object.getPrototypeOf(adapters) !== Object.prototype) {
    throw new TypeError("OUTBOX_ADAPTER_REGISTRY_REQUIRED");
  }
  if (typeof workerId !== "string" || !workerId ||
      typeof actorId !== "string" || !actorId) {
    throw new TypeError("OUTBOX_WORKER_IDENTITY_REQUIRED");
  }
  if (telemetry !== undefined && telemetry !== null &&
      (typeof telemetry.recordSecurityEvent !== "function" ||
       typeof telemetry.observe !== "function")) {
    throw new TypeError("OUTBOX_TELEMETRY_INVALID");
  }

  function emit(name, item, outcome, reason, durationMs = null) {
    const correlationId = taskCorrelationId(item);
    if (!telemetry || !correlationId) return;
    try {
      telemetry.recordSecurityEvent({
        name,
        correlationId,
        component: "outbox-worker",
        outcome,
        reason,
        ...(durationMs === null ? {} : { durationMs })
      });
    } catch { /* telemetry must not change outbox state or delivery */ }
  }

  function observe(durationMs, outcome, reason) {
    if (!telemetry) return;
    try {
      telemetry.observe("kratt.outbox.provider_dispatch.duration", durationMs, {
        component: "outbox-worker",
        outcome,
        reason
      });
    } catch { /* telemetry is non-authoritative */ }
  }

  async function runOnce({ limit = 10, leaseSeconds = 60 } = {}) {
    const claimed = await store.claimOutbox({ workerId, limit, leaseSeconds });
    const results = [];

    for (const item of claimed) {
      const adapter = Object.hasOwn(adapters,item.provider) ? adapters[item.provider] : null;
      if (!adapter || typeof adapter.dispatch !== "function") {
        const retry = await store.retryOutbox({
          outboxId: item.outbox_id,
          leaseToken: item.lease_token,
          errorCode: "PROVIDER_ADAPTER_UNAVAILABLE",
          maxAttempts
        });
        emit("dispatch.failed", item, "failed", "PROVIDER_ADAPTER_UNAVAILABLE");
        results.push({ outbox_id: item.outbox_id, status: "RETRY_SCHEDULED", retry });
        continue;
      }

      const started = performance.now();
      try {
        const result = await adapter.dispatch({
          payload: item.payload,
          idempotencyKey:item.idempotency_key
        });
        const duration = performance.now() - started;
        const valid = result && typeof result === "object" &&
          ["accepted", "completed"].includes(result.status);
        const outcome = valid
          ? { status: "COMPLETED", audit_result: { status: result.status } }
          : { status: "FAILED", audit_result: { status: "invalid_result" } };
        const finished = await store.finishOutbox({
          outboxId: item.outbox_id,
          leaseToken: item.lease_token,
          actorId,
          taskId: item.payload?.task?.task_id ?? item.payload?.task_id,
          outcome
        });
        observe(duration, valid ? "completed" : "failed",
          valid ? "PROVIDER_RESULT_ACCEPTED" : "INVALID_PROVIDER_RESULT");

        if (!finished.ok) {
          emit("lease.fenced", item, "failed", "OUTBOX_LEASE_LOST", duration);
          results.push({ outbox_id: item.outbox_id, status: "LEASE_LOST" });
        } else if (valid) {
          emit("dispatch.completed", item, "completed",
            result.status === "completed" ? "PROVIDER_RESULT_COMPLETED" : "PROVIDER_RESULT_ACCEPTED",
            duration);
          results.push({ outbox_id: item.outbox_id, status: "RECORDED" });
        } else {
          emit("dispatch.failed", item, "failed", "INVALID_PROVIDER_RESULT", duration);
          results.push({ outbox_id: item.outbox_id, status: "RECORDED" });
        }
      } catch {
        const duration = performance.now() - started;
        const retry = await store.retryOutbox({
          outboxId: item.outbox_id,
          leaseToken: item.lease_token,
          errorCode: "PROVIDER_DISPATCH_FAILED",
          maxAttempts
        });
        observe(duration, "failed", "PROVIDER_DISPATCH_FAILED");
        emit("dispatch.failed", item, "failed", "PROVIDER_DISPATCH_FAILED", duration);
        results.push({ outbox_id: item.outbox_id, status: "RETRY_SCHEDULED", retry });
      }
    }

    return { claimed: claimed.length, results };
  }

  return Object.freeze({ runOnce });
}
