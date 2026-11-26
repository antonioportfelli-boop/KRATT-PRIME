import test from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_LAYERS, RUNTIME_RECONCILIATION_VERSION, validateRuntimeLayers } from "../src/runtime-reconciliation.mjs";

test("runtime reconciliation inventory has valid dependency graph", () => {
  assert.equal(RUNTIME_RECONCILIATION_VERSION, "kratt-runtime-reconciliation/v1");
  assert.deepEqual(validateRuntimeLayers(), { ok: true, errors: [] });
});
test("does not represent draft worker leases as present on main", () => {
  const leases = RUNTIME_LAYERS.find(layer => layer.id === "durable-worker-leases");
  assert.equal(leases.evidence, "OPEN_DRAFT_DEPENDENCY");
  assert.equal(leases.candidate, "feature/durable-worker-leases-fencing-v1");
  assert.deepEqual(leases.source, []);
});
test("does not represent reflection recovery as implemented on main", () => {
  const recovery = RUNTIME_LAYERS.find(layer => layer.id === "reflection-recovery");
  assert.equal(recovery.evidence, "NOT_PRESENT_ON_MAIN");
  assert.deepEqual(recovery.source, []);
});
test("detects unknown dependencies, cycles and duplicate layer IDs", () => {
  const invalid = [
    { id: "a", evidence: "MAIN", source: [], dependsOn: ["missing"] },
    { id: "a", evidence: "MAIN", source: [], dependsOn: ["b"] },
    { id: "b", evidence: "MAIN", source: [], dependsOn: ["a"] },
  ];
  const result = validateRuntimeLayers(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(x => x.startsWith("LAYER_ID_DUPLICATE:")));
  assert.ok(result.errors.some(x => x.startsWith("DEPENDENCY_UNKNOWN:")));
  assert.ok(result.errors.some(x => x.startsWith("DEPENDENCY_CYCLE:")));
});
test("rejects invalid evidence states and duplicate source/dependency references", () => {
  const invalid = [{ id: "a", evidence: "DONE", source: ["x", "x"], dependsOn: ["b", "b"] }];
  const result = validateRuntimeLayers(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("LAYER_EVIDENCE_INVALID:a"));
  assert.ok(result.errors.includes("LAYER_SOURCE_INVALID:a"));
  assert.ok(result.errors.includes("LAYER_DEPENDENCIES_INVALID:a"));
});