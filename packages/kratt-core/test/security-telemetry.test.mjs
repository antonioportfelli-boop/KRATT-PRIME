import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityTelemetry } from "../src/security-telemetry.mjs";

test("records structured security events without raw payloads", () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: event => events.push(event), now: () => "2026-11-27T12:00:00.000Z" });
  assert.equal(telemetry.recordSecurityEvent({
    name: "authorization.denied",
    correlationId: "corr-1",
    component: "policy-engine",
    outcome: "denied",
    reason: "TARGET_OUT_OF_SCOPE",
    durationMs: 2.4,
  }), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "TARGET_OUT_OF_SCOPE");
  assert.equal(Object.hasOwn(events[0], "payload"), false);
});

test("rejects unbounded or high-cardinality labels", () => {
  const telemetry = createSecurityTelemetry({ maxSeries: 1 });
  assert.equal(telemetry.increment("kratt.authorization.total", { outcome: "allowed", reason: "OK" }), true);
  assert.equal(telemetry.increment("kratt.authorization.total", { outcome: "denied", reason: "NO" }), false);
  assert.equal(telemetry.increment("kratt.authorization.total", { userEmail: "private@example.test" }), false);
});

test("telemetry sink failure cannot affect the caller", () => {
  const telemetry = createSecurityTelemetry({ sink: () => { throw new Error("sink down"); } });
  assert.equal(telemetry.recordSecurityEvent({
    name: "dispatch.failed", correlationId: "corr-2", outcome: "failed", reason: "PROVIDER_UNAVAILABLE",
  }), true);
});

test("latency observations are bounded and aggregatable", () => {
  const telemetry = createSecurityTelemetry();
  telemetry.observe("kratt.dispatch.duration", 10, { component: "runtime", outcome: "completed", reason: "OK" });
  telemetry.observe("kratt.dispatch.duration", 20, { component: "runtime", outcome: "completed", reason: "OK" });
  const item = telemetry.snapshot().latency[0];
  assert.equal(item.count, 2);
  assert.equal(item.meanMs, 15);
  assert.equal(item.maxMs, 20);
});

test("rejects unknown event type and malformed correlation identifier", () => {
  const telemetry = createSecurityTelemetry();
  assert.equal(telemetry.recordSecurityEvent({
    name: "arbitrary.event", correlationId: "bad id", outcome: "allowed", reason: "OK",
  }), false);
});
