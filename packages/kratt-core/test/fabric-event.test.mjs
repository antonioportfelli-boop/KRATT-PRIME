import test from "node:test";
import assert from "node:assert/strict";
import { FABRIC_EVENT_SCHEMA, validateFabricEvent } from "../src/fabric-event.mjs";

const event = (overrides = {}) => ({
  schema_version: FABRIC_EVENT_SCHEMA,
  event_id: "evt-001",
  event_type: "agent.task.created",
  source: { node_id: "node-a", agent_id: "agent-builder", component: "kratt" },
  occurred_at: "2026-11-17T10:00:00Z",
  correlation_id: "corr-001",
  causation_id: null,
  sequence: 1,
  payload: { task_id: "task-001", requested_action: "repository.read" },
  ...overrides
});

test("accepts a valid event and returns a deeply immutable snapshot", () => {
  const input = event();
  const result = validateFabricEvent(input);
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.source), true);
  assert.equal(Object.isFrozen(result.value.payload), true);
  input.payload.task_id = "tampered";
  assert.equal(result.value.payload.task_id, "task-001");
});

test("rejects unknown top-level fields rather than silently accepting privilege hints", () => {
  assert.deepEqual(validateFabricEvent({ ...event(), admin: true }), {
    ok: false, errors: ["EVENT_SHAPE_INVALID"]
  });
});

test("rejects unsupported schema and malformed event types", () => {
  assert.ok(validateFabricEvent(event({ schema_version: "3xt-fabric-event/v2" })).errors.includes("EVENT_SCHEMA_UNSUPPORTED"));
  assert.ok(validateFabricEvent(event({ event_type: "Agent Task Created" })).errors.includes("EVENT_TYPE_INVALID"));
});

test("rejects malformed source, timestamps, and sequence values", () => {
  const result = validateFabricEvent(event({
    source: { node_id: "node-a", agent_id: "agent-builder", component: "kratt", trusted: true },
    occurred_at: "tomorrow",
    sequence: 0
  }));
  assert.ok(result.errors.includes("EVENT_SOURCE_INVALID"));
  assert.ok(result.errors.includes("EVENT_TIMESTAMP_INVALID"));
  assert.ok(result.errors.includes("EVENT_SEQUENCE_INVALID"));
});

test("rejects executable, non-finite, and prototype-bearing payload values", () => {
  assert.ok(validateFabricEvent(event({ payload: { amount: Number.NaN } })).errors.includes("EVENT_PAYLOAD_INVALID"));
  assert.ok(validateFabricEvent(event({ payload: { run() {} } })).errors.includes("EVENT_PAYLOAD_INVALID"));
  const polluted = JSON.parse('{"__proto__":{"admin":true}}');
  assert.ok(validateFabricEvent(event({ payload: polluted })).errors.includes("EVENT_PAYLOAD_INVALID"));
});

test("rejects accessors instead of invoking caller-controlled getters", () => {
  const payload = {};
  Object.defineProperty(payload, "danger", { enumerable: true, get() { throw new Error("getter executed"); } });
  const result = validateFabricEvent(event({ payload }));
  assert.ok(result.errors.includes("EVENT_PAYLOAD_INVALID"));
});

test("rejects excessive payload depth and node counts", () => {
  let nested = { leaf: true };
  for (let i = 0; i < 14; i += 1) nested = { child: nested };
  assert.ok(validateFabricEvent(event({ payload: nested })).errors.includes("EVENT_PAYLOAD_INVALID"));
});
