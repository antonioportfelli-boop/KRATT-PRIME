import test from "node:test";
import assert from "node:assert/strict";
import { FABRIC_EVENT_SCHEMA } from "../src/fabric-event.mjs";
import { STEEL_FABRIC_PROTOCOL, STEEL_FABRIC_ADAPTER_FIELDS, assessKrattToSteelFabricCompatibility } from "../src/fabric-compatibility.mjs";

const event = (overrides = {}) => ({
  schema_version: FABRIC_EVENT_SCHEMA,
  event_id: "evt-001",
  event_type: "agent.task.created",
  source: { node_id: "node-a", agent_id: "agent-builder", component: "kratt" },
  occurred_at: "2026-11-26T10:00:00Z",
  correlation_id: "corr-001",
  causation_id: null,
  sequence: 1,
  payload: { task_id: "task-001", requested_action: "repository.read" },
  ...overrides,
});

test("documents that KRATT and STEEL v1 envelope identifiers are distinct", () => {
  assert.equal(FABRIC_EVENT_SCHEMA, "3xt-fabric-event/v1");
  assert.equal(STEEL_FABRIC_PROTOCOL, "3XT-FABRIC/1");
});
test("a valid KRATT event is not treated as directly wire-compatible with STEEL", () => {
  const result = assessKrattToSteelFabricCompatibility(event());
  assert.equal(result.ok, true);
  assert.equal(result.wireCompatible, false);
  assert.equal(result.code, "TRUSTED_ADAPTER_REQUIRED");
  assert.equal(result.dispatchAllowed, false);
});
test("adapter report lists the fields STEEL requires but KRATT v1 does not carry", () => {
  const result = assessKrattToSteelFabricCompatibility(event());
  assert.deepEqual(result.missingTargetFields, STEEL_FABRIC_ADAPTER_FIELDS);
  assert.ok(result.missingTargetFields.includes("key_id"));
  assert.ok(result.missingTargetFields.includes("signature"));
  assert.ok(result.missingTargetFields.includes("scope"));
});
test("invalid KRATT envelopes cannot enter the compatibility assessment", () => {
  const result = assessKrattToSteelFabricCompatibility(event({ schema_version: "3xt-fabric-event/v2" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "KRATT_EVENT_INVALID");
});
test("compatibility assessment does not invent timestamp or causation semantics", () => {
  const result = assessKrattToSteelFabricCompatibility(event());
  assert.ok(result.semanticDecisionsRequired.some(x => x.includes("occurred_at")));
  assert.ok(result.semanticDecisionsRequired.some(x => x.includes("causation_id")));
  assert.ok(result.semanticDecisionsRequired.some(x => x.includes("trusted server-side policy")));
});