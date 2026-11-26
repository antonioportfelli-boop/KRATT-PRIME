import test from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_LAYERS, RUNTIME_RECONCILIATION_VERSION, validateRuntimeLayers } from "../src/runtime-reconciliation.mjs";

const byId = id => RUNTIME_LAYERS.find(layer => layer.id === id);

test("runtime reconciliation inventory has a valid dependency graph", () => {
  assert.equal(RUNTIME_RECONCILIATION_VERSION, "kratt-runtime-reconciliation/v1");
  assert.deepEqual(validateRuntimeLayers(), { ok: true, errors: [] });
});

test("mainline lease and governed execution capabilities are labelled with their real limits", () => {
  assert.equal(byId("worker-leases").evidence, "MAIN_LOCAL_ONLY");
  assert.equal(byId("governed-execution").evidence, "MAIN_NO_EXTERNAL_EFFECTS");
  assert.ok(byId("governed-execution").source.includes("packages/kratt-runtime/src/governed-execution.mjs"));
});

test("execution recovery is read-only and reflection is not misrepresented as shipped", () => {
  assert.equal(byId("execution-recovery").evidence, "MAIN_NO_REPLAY");
  assert.equal(byId("reflection-engine").evidence, "NOT_PRESENT_ON_MAIN");
  assert.deepEqual(byId("reflection-engine").source, []);
});

test("PostgreSQL runtime adapters remain marked as branch work until CI and database integration pass", () => {
  for (const id of ["postgres-runtime-journal", "postgres-worker-leases", "postgres-governed-runtime"]) {
    assert.equal(byId(id).evidence, "WAVE2_BRANCH_PENDING_CI");
  }
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