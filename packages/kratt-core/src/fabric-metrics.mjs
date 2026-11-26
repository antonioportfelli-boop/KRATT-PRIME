// Bounded, label-free Fabric metrics. Metrics are advisory and can never fail an
// authorization, persistence, delivery, acknowledgement or recovery decision.
export const FABRIC_COUNTER_METRICS = Object.freeze([
  "fabric_outbound_events_total",
  "fabric_receiver_accepted_total",
  "fabric_receiver_duplicate_total",
  "fabric_receiver_rejected_total",
  "fabric_receiver_unknown_total",
  "fabric_ack_verified_total",
  "fabric_ack_rejected_total",
  "fabric_ack_replayed_total",
  "fabric_delivery_lease_expired",
  "fabric_delivery_fence_rejected",
  "fabric_task_cancelled",
  "fabric_idempotency_conflicts",
  "fabric_audit_integrity_failures"
]);

export const FABRIC_GAUGE_METRICS = Object.freeze([
  "fabric_outbox_pending",
  "fabric_outbox_reconcile_required"
]);

const COUNTERS = new Set(FABRIC_COUNTER_METRICS);
const GAUGES = new Set(FABRIC_GAUGE_METRICS);

/**
 * Metrics sink contract: { increment(name, amount), gauge(name, value) }.
 * Names come from fixed allowlists; callers cannot attach labels or identities.
 */
export function incrementFabricMetric(metrics, name, amount = 1) {
  if (!metrics || !COUNTERS.has(name) || !Number.isSafeInteger(amount) || amount < 1 ||
      typeof metrics.increment !== "function") return false;
  try {
    metrics.increment(name, amount);
    return true;
  } catch {
    return false;
  }
}

export function setFabricGauge(metrics, name, value) {
  if (!metrics || !GAUGES.has(name) || !Number.isFinite(value) || value < 0 ||
      typeof metrics.gauge !== "function") return false;
  try {
    metrics.gauge(name, value);
    return true;
  } catch {
    return false;
  }
}
