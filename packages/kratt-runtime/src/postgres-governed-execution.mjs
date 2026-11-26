import { createPostgresRuntimeStore } from "../../kratt-core/src/postgres-runtime-store.mjs";
import { createPostgresTrustedAuthorizationRuntime } from "../../kratt-core/src/postgres-trusted-authorization.mjs";
import { createPostgresWorkerLeaseCoordinator } from "./postgres-worker-lease-coordinator.mjs";
import { DurableEvidenceRepository } from "./durable-evidence.mjs";
import { createGovernedExecutionRuntime } from "./governed-execution.mjs";

/**
 * Asynchronous PostgreSQL composition root for the existing governed runtime.
 *
 * The application owns the supplied pool and is responsible for TLS, database
 * roles, connection limits, migrations, backups and monitoring. This factory
 * never runs DDL, creates credentials, starts workers or enables dispatch.
 */
export async function createPostgresGovernedExecutionRuntime({
  pool,
  trustedApprovalKeys,
  verifyPolicyEvidence,
  ...runtimeOptions
} = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("POSTGRES_POOL_REQUIRED");
  }
  for (const forbidden of ["store", "leaseCoordinator", "evidenceRepository", "authorizationRuntime"]) {
    if (Object.hasOwn(runtimeOptions, forbidden)) {
      throw new TypeError("POSTGRES_RUNTIME_DEPENDENCY_OVERRIDE_FORBIDDEN:" + forbidden);
    }
  }
  if (!Array.isArray(trustedApprovalKeys) || trustedApprovalKeys.length === 0 ||
      typeof verifyPolicyEvidence !== "function" ||
      typeof runtimeOptions.authenticatePrincipal !== "function" ||
      typeof runtimeOptions.loadTrustedContext !== "function" ||
      typeof runtimeOptions.verifyEvidenceProvenance !== "function") {
    throw new TypeError("TRUSTED_GOVERNED_RUNTIME_HOST_DEPENDENCIES_REQUIRED");
  }

  const authorizationRuntime = createPostgresTrustedAuthorizationRuntime({
    pool,
    trustedApprovalKeys,
    verifyEvidence: verifyPolicyEvidence,
    now: runtimeOptions.nowEpochMs ?? (() => Date.now())
  });
  await authorizationRuntime.open();

  const store = createPostgresRuntimeStore(pool);
  await store.open();
  const journal = await store.verify();
  if (journal?.ok !== true) throw new Error("POSTGRES_RUNTIME_JOURNAL_NOT_VERIFIED");

  const evidenceRepository = new DurableEvidenceRepository({ store });
  await evidenceRepository.open();
  const evidence = await evidenceRepository.verify();
  if (evidence?.ok !== true) throw new Error("POSTGRES_RUNTIME_EVIDENCE_NOT_VERIFIED");

  const leaseCoordinator = createPostgresWorkerLeaseCoordinator(pool);
  await leaseCoordinator.open();
  const leases = await leaseCoordinator.status();
  if (leases?.ok !== true) throw new Error("POSTGRES_WORKER_LEASE_STORE_NOT_READY");

  const runtime = createGovernedExecutionRuntime({
    ...runtimeOptions,
    authorizationRuntime,
    store,
    evidenceRepository,
    leaseCoordinator
  });

  async function readiness() {
    try {
      const [journalState, evidenceState, leaseState] = await Promise.all([
        store.verify(),
        evidenceRepository.verify(),
        leaseCoordinator.status()
      ]);
      const ready = journalState?.ok === true && evidenceState?.ok === true && leaseState?.ok === true;
      return Object.freeze({
        ok: ready,
        backend: "POSTGRES_SHARED_DATABASE",
        journal: Object.freeze({
          ok: journalState?.ok === true,
          entries: journalState?.count ?? null,
          head_hash: journalState?.headHash ?? null
        }),
        evidence: Object.freeze({
          ok: evidenceState?.ok === true,
          events: evidenceState?.eventCount ?? null,
          scope: evidenceState?.scope ?? null
        }),
        storageProtection: Object.freeze({
          encryptionAtRest: evidenceState?.encrypted === true ? "VERIFIED" :
            evidenceState?.encrypted === false ? "NOT_ENCRYPTED" : "UNVERIFIED",
          remoteReplication: evidenceState?.remoteSync === true ? "VERIFIED" :
            evidenceState?.remoteSync === false ? "DISABLED" : "UNVERIFIED"
        }),
        leases: Object.freeze({
          ok: leaseState?.ok === true,
          reservations: leaseState?.reservationCount ?? null,
          active: leaseState?.activeLeaseCount ?? null,
          expired: leaseState?.expiredLeaseCount ?? null
        }),
        dispatch: false,
        externalEffects: false
      });
    } catch {
      return Object.freeze({
        ok: false,
        backend: "POSTGRES_SHARED_DATABASE",
        reason: "POSTGRES_RUNTIME_READINESS_CHECK_FAILED",
        dispatch: false,
        externalEffects: false
      });
    }
  }

  return Object.freeze({
    ...runtime,
    backend: Object.freeze({
      kind: "POSTGRES_SHARED_DATABASE",
      schemaVersion: "kratt-runtime-postgres/v1",
      migrations: Object.freeze([
        "packages/kratt-core/migrations/0002_postgres_runtime_and_leases.sql"
      ]),
      approvalNonceMode: "POSTGRES_SHARED_UNIQUE_INSERT",
      poolOwnership: "CALLER",
      dispatch: false,
      externalEffects: false
    }),
    readiness
  });
}
