import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityTelemetry } from "../src/security-telemetry.mjs";

const event = (index = 1, overrides = {}) => ({
  name: "authorization.denied",
  correlationId: `corr-${index}`,
  component: "policy-engine",
  outcome: "denied",
  reason: "TARGET_OUT_OF_SCOPE",
  ...overrides,
});

test("records structured security events without raw payloads", () => {
  const events = [];
  const telemetry = createSecurityTelemetry({ sink: value => events.push(value), now: () => "2026-11-27T12:00:00.000Z" });
  assert.equal(telemetry.recordSecurityEvent(event()), true);
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

test("synchronous sink failure is isolated and counted", () => {
  const telemetry = createSecurityTelemetry({ sink: () => { throw new Error("sink down"); } });
  assert.equal(telemetry.recordSecurityEvent(event(2, { name: "dispatch.failed", outcome: "failed", reason: "PROVIDER_UNAVAILABLE" })), true);
  assert.equal(telemetry.snapshot().diagnostics.sinkFailures, 1);
});

test("asynchronous sink rejection is consumed and counted", async () => {
  const telemetry = createSecurityTelemetry({ sink: async () => { throw new Error("async sink down"); } });
  assert.equal(telemetry.recordSecurityEvent(event(3)), true);
  await new Promise(resolve => setImmediate(resolve));
  const diagnostics = telemetry.snapshot().diagnostics;
  assert.equal(diagnostics.sinkFailures, 1);
  assert.equal(diagnostics.pendingSinks, 0);
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
  assert.equal(telemetry.recordSecurityEvent(event(4, { name: "arbitrary.event", correlationId: "bad id" })), false);
});

test("exposes bounded ring overflow instead of silently losing old events", () => {
  const telemetry = createSecurityTelemetry({ sink: () => {} });
  for (let index = 1; index <= 520; index += 1) assert.equal(telemetry.recordSecurityEvent(event(index)), true);
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.recentSecurityEvents.length, 512);
  assert.equal(snapshot.recentSecurityEvents[0].correlationId, "corr-9");
  assert.equal(snapshot.recentSecurityEvents.at(-1).correlationId, "corr-520");
  assert.equal(snapshot.diagnostics.eventRingDropped, 8);
});

test("bounds pending asynchronous sinks and retains the local event", async () => {
  const resolvers = [];
  let calls = 0;
  const telemetry = createSecurityTelemetry({
    maxPendingSinks: 2,
    sink: () => { calls += 1; return new Promise(resolve => resolvers.push(resolve)); },
  });
  telemetry.recordSecurityEvent(event(1));
  telemetry.recordSecurityEvent(event(2));
  telemetry.recordSecurityEvent(event(3));
  assert.equal(calls, 2);
  assert.equal(telemetry.snapshot().recentSecurityEvents.length, 3);
  assert.equal(telemetry.snapshot().diagnostics.sinkDropped, 1);
  resolvers.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(telemetry.snapshot().diagnostics.pendingSinks, 0);
});

test("clock failure and malformed event getters cannot escape the telemetry boundary", () => {
  const telemetry = createSecurityTelemetry({ now: () => { throw new Error("clock unavailable"); } });
  assert.equal(telemetry.recordSecurityEvent(event(5)), false);
  const malformed = {};
  Object.defineProperty(malformed, "name", { enumerable: true, get() { throw new Error("getter"); } });
  assert.equal(telemetry.recordSecurityEvent(malformed), false);
});
