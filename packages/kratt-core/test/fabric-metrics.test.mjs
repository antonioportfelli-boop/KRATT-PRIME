import test from "node:test";
import assert from "node:assert/strict";
import {
  FABRIC_COUNTER_METRICS,
  FABRIC_GAUGE_METRICS,
  incrementFabricMetric,
  setFabricGauge
} from "../src/fabric-metrics.mjs";

test("Fabric metrics accept only fixed label-free counter and gauge names", () => {
  const calls = [];
  const sink = {
    increment: (...args) => calls.push(["increment", ...args]),
    gauge: (...args) => calls.push(["gauge", ...args])
  };
  assert.equal(incrementFabricMetric(sink, "fabric_ack_verified_total"), true);
  assert.equal(incrementFabricMetric(sink, "fabric_ack_verified_total", 3), true);
  assert.equal(setFabricGauge(sink, "fabric_outbox_pending", 7), true);
  assert.equal(incrementFabricMetric(sink, "fabric_ack_verified_total{receiver='secret'}"), false);
  assert.equal(incrementFabricMetric(sink, "arbitrary.metric"), false);
  assert.equal(setFabricGauge(sink, "fabric_ack_verified_total", 2), false);
  assert.equal(setFabricGauge(sink, "fabric_outbox_pending", -1), false);
  assert.deepEqual(calls, [
    ["increment", "fabric_ack_verified_total", 1],
    ["increment", "fabric_ack_verified_total", 3],
    ["gauge", "fabric_outbox_pending", 7]
  ]);
  assert.ok(FABRIC_COUNTER_METRICS.includes("fabric_idempotency_conflicts"));
  assert.ok(FABRIC_GAUGE_METRICS.includes("fabric_outbox_reconcile_required"));
});

test("metrics sink failures are isolated from the caller's transaction", () => {
  const sink = {
    increment() { throw new Error("metrics exporter offline"); },
    gauge() { throw new Error("metrics exporter offline"); }
  };
  assert.equal(incrementFabricMetric(sink, "fabric_ack_rejected_total"), false);
  assert.equal(setFabricGauge(sink, "fabric_outbox_pending", 1), false);
});
