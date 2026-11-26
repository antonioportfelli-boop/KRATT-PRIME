/**
 * Wave 2 runtime reconciliation baseline.
 *
 * This is an inventory and dependency guard, not a runtime orchestrator.
 * Statuses describe repository evidence as of 2026-11-26 and must be refreshed
 * when candidate PRs change. It deliberately does not import or activate draft
 * runtime components.
 */
export const RUNTIME_RECONCILIATION_VERSION = "kratt-runtime-reconciliation/v1";

export const RUNTIME_LAYERS = Object.freeze([
  Object.freeze({
    id: "task-contract",
    responsibility: "Define immutable construction task and guarded lifecycle transitions",
    evidence: "MAIN",
    source: Object.freeze(["packages/kratt-core/src/construction-protocol.mjs"]),
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "execution-ledger",
    responsibility: "Derive deterministic execution identity and validate state/fencing history",
    evidence: "MAIN",
    source: Object.freeze(["packages/kratt-core/src/construction-execution-ledger.mjs"]),
    dependsOn: Object.freeze(["task-contract"]),
  }),
  Object.freeze({
    id: "trusted-authorization",
    responsibility: "Verify request-bound approval, trusted evidence and policy before dispatch",
    evidence: "MAIN",
    source: Object.freeze([
      "packages/kratt-core/src/trusted-runtime.mjs",
      "packages/kratt-core/src/policy.mjs",
      "packages/kratt-core/src/approval-evidence.mjs",
    ]),
    dependsOn: Object.freeze(["task-contract"]),
  }),
  Object.freeze({
    id: "evidence-ledger",
    responsibility: "Append and verify local hash-chained evidence; production durability is not provided by this reference ledger",
    evidence: "MAIN_REFERENCE_ONLY",
    source: Object.freeze([
      "packages/kratt-core/src/evidence-ledger.mjs",
      "packages/kratt-core/src/evidence-integrity.mjs",
    ]),
    dependsOn: Object.freeze(["task-contract"]),
  }),
  Object.freeze({
    id: "durable-worker-leases",
    responsibility: "Claim work with durable leases and fencing tokens",
    evidence: "OPEN_DRAFT_DEPENDENCY",
    source: Object.freeze([]),
    dependsOn: Object.freeze(["execution-ledger", "trusted-authorization"]),
    candidate: "feature/durable-worker-leases-fencing-v1",
  }),
  Object.freeze({
    id: "authorized-dispatch",
    responsibility: "Bind approved intent to idempotent reservation, outbox and audit record",
    evidence: "MAIN",
    source: Object.freeze([
      "packages/kratt-core/src/authorized-dispatch.mjs",
      "packages/kratt-core/src/outbox-worker.mjs",
      "packages/kratt-core/src/postgres-outbox-store.mjs",
    ]),
    dependsOn: Object.freeze(["trusted-authorization", "evidence-ledger"]),
  }),
  Object.freeze({
    id: "reflection-recovery",
    responsibility: "Persist recovery/reflection state and reconcile it against execution/evidence history",
    evidence: "NOT_PRESENT_ON_MAIN",
    source: Object.freeze([]),
    dependsOn: Object.freeze(["execution-ledger", "evidence-ledger", "durable-worker-leases"]),
  }),
]);

export function validateRuntimeLayers(layers = RUNTIME_LAYERS) {
  const errors = [];
  if (!Array.isArray(layers)) return { ok: false, errors: ["LAYERS_NOT_ARRAY"] };
  const ids = new Set();
  for (const layer of layers) {
    if (!layer || typeof layer.id !== "string" || !layer.id) {
      errors.push("LAYER_ID_INVALID");
      continue;
    }
    if (ids.has(layer.id)) errors.push("LAYER_ID_DUPLICATE:" + layer.id);
    ids.add(layer.id);
    if (!["MAIN", "MAIN_REFERENCE_ONLY", "OPEN_DRAFT_DEPENDENCY", "NOT_PRESENT_ON_MAIN"].includes(layer.evidence)) {
      errors.push("LAYER_EVIDENCE_INVALID:" + layer.id);
    }
    if (!Array.isArray(layer.source) || new Set(layer.source).size !== layer.source.length) {
      errors.push("LAYER_SOURCE_INVALID:" + layer.id);
    }
    if (!Array.isArray(layer.dependsOn) || new Set(layer.dependsOn).size !== layer.dependsOn.length) {
      errors.push("LAYER_DEPENDENCIES_INVALID:" + layer.id);
    }
  }
  for (const layer of layers) {
    if (!layer || !Array.isArray(layer.dependsOn)) continue;
    for (const dep of layer.dependsOn) {
      if (!ids.has(dep)) errors.push("DEPENDENCY_UNKNOWN:" + layer.id + ":" + dep);
      if (dep === layer.id) errors.push("DEPENDENCY_SELF:" + layer.id);
    }
  }
  const byId = new Map(layers.filter(x => x && typeof x.id === "string").map(x => [x.id, x]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      errors.push("DEPENDENCY_CYCLE:" + id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}
