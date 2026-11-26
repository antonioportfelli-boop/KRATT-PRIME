/**
 * Wave 2 runtime inventory and dependency validator.
 *
 * Maturity labels are intentionally precise: the mainline bridge is real,
 * but its PrimeStore/lease path is local and single-process. PostgreSQL
 * runtime adapters in this Wave 2 branch remain subject to CI and a live
 * PostgreSQL integration run before any deployment claim.
 */
export const RUNTIME_RECONCILIATION_VERSION = "kratt-runtime-reconciliation/v1";

const EVIDENCE_STATES = Object.freeze([
  "MAIN",
  "MAIN_LOCAL_ONLY",
  "MAIN_NO_EXTERNAL_EFFECTS",
  "MAIN_NO_REPLAY",
  "MAIN_POSTGRES_LIBRARY",
  "NOT_PRESENT_ON_MAIN",
  "WAVE2_BRANCH_PENDING_CI",
]);

export const RUNTIME_LAYERS = Object.freeze([
  Object.freeze({
    id: "task-contract",
    responsibility: "Immutable construction task and guarded lifecycle transitions",
    evidence: "MAIN",
    source: Object.freeze(["packages/kratt-core/src/construction-protocol.mjs"]),
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    id: "execution-ledger",
    responsibility: "Deterministic execution identity, immutable revisions and fencing checks",
    evidence: "MAIN",
    source: Object.freeze(["packages/kratt-core/src/construction-execution-ledger.mjs"]),
    dependsOn: Object.freeze(["task-contract"]),
  }),
  Object.freeze({
    id: "trusted-authorization",
    responsibility: "WP-01 policy, request-bound approval and trusted evidence verification",
    evidence: "MAIN",
    source: Object.freeze([
      "packages/kratt-core/src/trusted-runtime.mjs",
      "packages/kratt-core/src/policy.mjs",
      "packages/kratt-core/src/approval-evidence.mjs",
    ]),
    dependsOn: Object.freeze(["task-contract"]),
  }),
  Object.freeze({
    id: "evidence-projection",
    responsibility: "Durable Evidence Cards and hash-chained evidence projection over PrimeStore",
    evidence: "MAIN_LOCAL_ONLY",
    source: Object.freeze([
      "packages/kratt-runtime/src/durable-evidence.mjs",
      "packages/kratt-runtime/src/evidence-kernel.mjs",
      "packages/kratt-core/src/evidence-ledger.mjs",
      "packages/kratt-core/src/prime-store.mjs",
    ]),
    dependsOn: Object.freeze(["task-contract"]),
  }),
  Object.freeze({
    id: "worker-leases",
    responsibility: "Persistent bounded leases and monotonically increasing fencing within a local single-process boundary",
    evidence: "MAIN_LOCAL_ONLY",
    source: Object.freeze(["packages/kratt-runtime/src/worker-lease-coordinator.mjs"]),
    dependsOn: Object.freeze(["execution-ledger"]),
  }),
  Object.freeze({
    id: "governed-execution",
    responsibility: "Bind WP-01 authorization, verified ECK, fenced lease, execution ledger and governance receipt",
    evidence: "MAIN_NO_EXTERNAL_EFFECTS",
    source: Object.freeze(["packages/kratt-runtime/src/governed-execution.mjs"]),
    dependsOn: Object.freeze([
      "task-contract", "execution-ledger", "trusted-authorization", "evidence-projection", "worker-leases"
    ]),
  }),
  Object.freeze({
    id: "execution-recovery",
    responsibility: "Verify journal, reject gaps/forks and return latest execution record without replay",
    evidence: "MAIN_NO_REPLAY",
    source: Object.freeze([
      "packages/kratt-core/src/construction-execution-ledger.mjs",
      "packages/kratt-runtime/src/governed-execution.mjs",
    ]),
    dependsOn: Object.freeze(["execution-ledger", "evidence-projection"]),
  }),
  Object.freeze({
    id: "postgres-outbox",
    responsibility: "PostgreSQL authorization intent, nonce/cancellation reservation and at-least-once outbox library",
    evidence: "MAIN_POSTGRES_LIBRARY",
    source: Object.freeze([
      "packages/kratt-core/src/postgres-outbox-store.mjs",
      "packages/kratt-core/migrations/0001_postgres_outbox.sql",
      "packages/kratt-core/src/outbox-worker.mjs",
    ]),
    dependsOn: Object.freeze(["trusted-authorization"]),
  }),
  Object.freeze({
    id: "reflection-engine",
    responsibility: "Durable persisted reflection/recovery journal integrated with governed execution",
    evidence: "NOT_PRESENT_ON_MAIN",
    source: Object.freeze([]),
    dependsOn: Object.freeze(["evidence-projection", "execution-recovery"]),
  }),
  Object.freeze({
    id: "postgres-runtime-journal",
    responsibility: "Shared PostgreSQL hash-chained journal compatible with evidence and execution stores",
    evidence: "WAVE2_BRANCH_PENDING_CI",
    source: Object.freeze(["packages/kratt-core/src/postgres-runtime-store.mjs"]),
    dependsOn: Object.freeze(["evidence-projection", "execution-ledger"]),
  }),
  Object.freeze({
    id: "postgres-approval-nonces",
    responsibility: "Shared PostgreSQL request-bound Ed25519 approval nonce consumption",
    evidence: "WAVE2_BRANCH_PENDING_CI",
    source: Object.freeze([
      "packages/kratt-core/src/postgres-trusted-authorization.mjs",
      "packages/kratt-core/migrations/0002_postgres_runtime_and_leases.sql",
    ]),
    dependsOn: Object.freeze(["trusted-authorization", "postgres-runtime-journal"]),
  }),
  Object.freeze({
    id: "postgres-worker-leases",
    responsibility: "Cross-process transactional worker leases and fencing using database row locks",
    evidence: "WAVE2_BRANCH_PENDING_CI",
    source: Object.freeze(["packages/kratt-runtime/src/postgres-worker-lease-coordinator.mjs"]),
    dependsOn: Object.freeze(["worker-leases", "postgres-runtime-journal"]),
  }),
  Object.freeze({
    id: "postgres-governed-runtime",
    responsibility: "PostgreSQL-backed composition of governed execution, evidence journal and fenced leases",
    evidence: "WAVE2_BRANCH_PENDING_CI",
    source: Object.freeze(["packages/kratt-runtime/src/postgres-governed-execution.mjs"]),
    dependsOn: Object.freeze(["governed-execution", "postgres-runtime-journal", "postgres-worker-leases"]),
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
    if (!EVIDENCE_STATES.includes(layer.evidence)) errors.push("LAYER_EVIDENCE_INVALID:" + layer.id);
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
