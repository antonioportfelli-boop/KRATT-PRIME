import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPostgresRuntimeStore } from "../src/postgres-runtime-store.mjs";
import { createPostgresWorkerLeaseCoordinator } from "../../kratt-runtime/src/postgres-worker-lease-coordinator.mjs";
import { createPostgresTrustedAuthorizationRuntime } from "../src/postgres-trusted-authorization.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "migrations/0002_postgres_runtime_and_leases.sql"), "utf8");
const journal = readFileSync(join(root, "src/postgres-runtime-store.mjs"), "utf8");
const leases = readFileSync(join(root, "../kratt-runtime/src/postgres-worker-lease-coordinator.mjs"), "utf8");
const composition = readFileSync(join(root, "../kratt-runtime/src/postgres-governed-execution.mjs"), "utf8");

test("PostgreSQL migration creates shared journal and fenced lease tables", () => {
  for (const name of [
    "kratt_runtime_journal_head",
    "kratt_runtime_journal_entries",
    "kratt_worker_lease_reservations",
    "kratt_worker_lease_operations",
    "kratt_governed_approval_nonces"
  ]) assert.ok(migration.includes(name), name);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON kratt_runtime_journal_entries/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON kratt_worker_lease_operations/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON kratt_governed_approval_nonces/);
  assert.match(migration, /NEW\.fence < OLD\.fence/);
  assert.match(migration, /ON CONFLICT \(singleton\) DO NOTHING/);
});

test("runtime journal implementation provides PrimeStore-compatible verified append APIs", () => {
  for (const name of ["async function open", "async function put", "async function readAll", "async function verify", "async function status"]) {
    assert.ok(journal.includes(name), name);
  }
  assert.match(journal, /REPEATABLE READ READ ONLY/);
  assert.match(journal, /FOR UPDATE/);
  assert.match(journal, /RUNTIME_JOURNAL_HASH_MISMATCH/);
  assert.match(journal, /RUNTIME_JOURNAL_HEAD_MISMATCH/);
});

test("worker coordinator uses database row locks, server clock and monotonically fenced operations", () => {
  assert.match(leases, /FOR UPDATE/);
  assert.match(leases, /clock_timestamp\(\)/);
  assert.match(leases, /WORKER_FENCING_TOKEN_STALE/);
  assert.match(leases, /WORKER_LEASE_OPERATION_ID_REUSED/);
  assert.match(leases, /WORKER_FENCE_EXHAUSTED/);
  assert.match(leases, /dispatch: false/);
});

test("PostgreSQL composition requires host trust dependencies and never enables external effects", () => {
  assert.match(composition, /TRUSTED_GOVERNED_RUNTIME_HOST_DEPENDENCIES_REQUIRED/);
  assert.match(composition, /createGovernedExecutionRuntime/);
  assert.match(composition, /dispatch: false/);
  assert.match(composition, /externalEffects: false/);
  assert.match(composition, /POSTGRES_RUNTIME_DEPENDENCY_OVERRIDE_FORBIDDEN/);
});

test("PostgreSQL trusted authorization exposes a shared one-time approval nonce contract", () => {
  const auth = readFileSync(join(root, "src/postgres-trusted-authorization.mjs"), "utf8");
  assert.match(auth, /canonicalApprovalPayload/);
  assert.match(auth, /verifySignature\(null/);
  assert.match(auth, /INSERT INTO kratt_governed_approval_nonces/);
  assert.match(auth, /ON CONFLICT DO NOTHING RETURNING key_id/);
  assert.match(auth, /APPROVAL_REPLAYED_OR_NONCE_STORE_UNAVAILABLE/);
  assert.equal(typeof createPostgresTrustedAuthorizationRuntime, "function");
});

test("PostgreSQL governed runtime exposes evidence intake while requiring independent provenance", () => {
  const composition = readFileSync(join(root, "../kratt-runtime/src/postgres-governed-execution.mjs"), "utf8");
  assert.match(composition, /appendEvidence: input => evidenceRepository\.append\(input\)/);
  assert.match(composition, /listEvidence: options => evidenceRepository\.list\(options\)/);
  assert.match(composition, /verifyEvidenceProvenance/);
  assert.match(composition, /provenance verifier/);
});

test("factories reject an incomplete pool before issuing queries", () => {
  assert.throws(() => createPostgresRuntimeStore({ connect() {} }), /POSTGRES_POOL_REQUIRED/);
  assert.throws(() => createPostgresWorkerLeaseCoordinator({ query() {} }), /POSTGRES_POOL_REQUIRED/);
});
