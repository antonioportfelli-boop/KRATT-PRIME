# Wave 2 — PostgreSQL Governed Runtime Staging Runbook

**Status:** staging candidate; not production approved  
**Code branch:** \`feature/wave2-runtime-reconciliation-2026-11-26\`  
**Database target for integration:** PostgreSQL 16  
**Node runtime:** Node.js 22

## 1. Capability and boundary

The Wave 2 PostgreSQL composition injects a shared journal, shared worker leases and shared request-bound approval nonce consumption into the existing KRATT governed execution state machine.

It provides:
- an append-only SHA-256 hash-chained runtime journal compatible with the existing PrimeStore API;
- database-serialized worker lease acquisition, renewal and release, with monotonically increasing fencing tokens;
- shared one-time approval nonce claims, unique by key/nonce and key/approval ID;
- asynchronous WP-01 policy evaluation, so nonce consumption is awaited;
- heartbeat revisions in the immutable execution history;
- readiness checks for journal integrity, ECK evidence projection and lease storage.

It does **not** dispatch a repository, provider, shell, filesystem or production operation. The governed bridge still returns \`dispatch: false\` and \`externalEffects: false\`. Any future worker must enforce the fencing token at the actual effect target, not merely trust the coordinator.

## 2. Migration

Apply \`packages/kratt-core/migrations/0002_postgres_runtime_and_leases.sql\` using the deployment's reviewed migration runner and a privileged migration role.

The migration creates:
- runtime journal head and append-only entries;
- immutable request-bound approval nonce claims;
- worker lease reservations and immutable operation records;
- triggers that reject journal/nonce/operation mutation and non-monotonic lease fences.

The runtime factory never executes DDL. It fails closed when the schema is missing.

The earlier \`0001_postgres_outbox.sql\` migration is only needed when deploying the separate Wave 4 provider outbox. The Wave 2 governed runtime itself uses migration 0002.

## 3. Least-privilege database role

Create a dedicated application role through the DBA-approved role-management process. Do not commit database passwords or connection strings to this repository.

The runtime role requires, at minimum:
- \`SELECT, INSERT\` on \`kratt_runtime_journal_entries\`;
- \`SELECT, UPDATE\` on \`kratt_runtime_journal_head\`;
- \`SELECT, INSERT\` on \`kratt_governed_approval_nonces\`;
- \`SELECT, INSERT, UPDATE\` on \`kratt_worker_lease_reservations\`;
- \`SELECT, INSERT\` on \`kratt_worker_lease_operations\`.

Do not grant DELETE on Wave 2 tables. Do not grant UPDATE on journal entries, approval nonce claims or lease operation records. The migration triggers reject these mutations as defence in depth. The application role must not own the tables, schema or trigger functions.

## 4. Host composition

The host owns the \`pg.Pool\`, TLS configuration, connection limits, secrets, lifecycle and shutdown. The runtime factory takes a host-supplied Ed25519 approval keyring and trusted identity/context/provenance callbacks.

Illustrative wiring:

\`\`\`js
import { Pool } from "pg";
import { createPostgresGovernedExecutionRuntime } from
  "./packages/kratt-runtime/src/postgres-governed-execution.mjs";

const pool = new Pool({
  connectionString: process.env.KRATT_DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ssl: { rejectUnauthorized: true },
});

const runtime = await createPostgresGovernedExecutionRuntime({
  pool,
  trustedApprovalKeys: deploymentApprovalKeyring,
  verifyPolicyEvidence: verifyPolicyEvidenceSynchronously,
  authenticatePrincipal: authenticateFromServerSession,
  loadTrustedContext: loadServerOwnedPolicyContext,
  verifyEvidenceProvenance: verifyEckEvidenceProvenance,
  nowEpochMs: () => Date.now(),
  leaseTtlMs: 60_000,
});

const readiness = await runtime.readiness();
if (!readiness.ok) throw new Error("KRATT_POSTGRES_RUNTIME_NOT_READY");
\`\`\`

This is a wiring example, not a production host. The deployment must supply:
- authenticated principal resolution from trusted server session/context; never accept actor identity from arbitrary request JSON;
- a current, server-owned trusted context and independently controlled kill switch;
- Ed25519 public keys from deployment-controlled configuration;
- a synchronous \`verifyPolicyEvidence\` callback, because the existing KRATT policy evaluator calls evidence verification synchronously;
- an independent ECK provenance verifier; a matching digest alone is not proof of source authenticity;
- clock synchronisation and a tested PostgreSQL connection pool.

The runtime factory reserves the authorization runtime, store, lease coordinator and evidence repository internally. Caller-supplied replacements for these components are rejected.

## 5. Operational semantics

### Authorization

The shared authorization runtime verifies the complete request-bound Ed25519 approval, trusted key identity, approver, authority, time window and canonical task digest. It then inserts the derived key ID, nonce, approval ID, request digest and signature digest using a unique constraint.

The nonce is consumed when this insert succeeds. If a later execution-ledger or lease step fails, the approval remains consumed and a fresh approval is required. This is deliberately fail-closed; it is not a distributed transaction across nonce, journal, lease and execution state.

### Worker leases

A reservation is bound to one immutable task digest. Acquisition serializes with a row lock and increments the fencing token. Renewal and release require the exact owner and current fence. Database time is authoritative for lease expiration. Replaying an old successful acquire after release or expiry is blocked.

A successful lease only reserves coordination state. It is not evidence that a worker is authenticated, running or authorized to perform an external side effect.

### Heartbeat

The runtime's \`renew\` API renews the database lease and then appends a new execution-ledger revision containing the same worker identity and fencing token with a later expiry. The caller must use the returned \`record\` for its next \`start\`, \`complete\`, \`fail\` or \`cancel\` call.

If the process loses the renewal response, it must recover the latest execution record and inspect the authoritative lease before continuing. It must not guess that the earlier revision is still current.

### Recovery and cancellation

Recovery verifies the journal and immutable execution revisions; it returns the latest valid state and does not replay or restart a worker.

A \`RUNNING\` task requires a real worker cancellation acknowledgement. The runtime rechecks the lease after that acknowledgement before persisting cancellation. A lease release alone is not treated as proof that a process stopped.

### Side effects

The current runtime has no real worker/side-effect adapter. Any future target must store and reject stale fencing tokens itself, recheck approval, scope and kill-switch at the side-effect boundary, provide idempotency and reconciliation, and produce independent evidence. Do not advertise exactly-once external delivery.

## 6. CI and integration

The repository workflow \`.github/workflows/postgres-runtime-integration.yml\` provisions an isolated PostgreSQL 16 service and runs:
1. \`npm ci\`;
2. all KRATT core contract tests;
3. app typecheck and build;
4. the PostgreSQL integration suite using the \`pg\` driver.

The live suite tests:
- concurrent journal appends through two independent pools;
- journal hash verification and append-only triggers;
- atomic unique approval nonce insertion across two pools;
- concurrent lease competition for one reservation;
- expiry, reacquisition with a higher fence, stale-fence rejection, renewal and release;
- observing persistent lease state through a separately constructed coordinator.

A skipped integration suite is not a pass. A successful CI service container is a useful staging test, but it is not a substitute for the actual target cloud/database configuration.

## 7. Required staging evidence before enabling any worker

- A reviewed migration applied to an isolated staging database.
- A real two-pool lease and nonce concurrency test against the selected PostgreSQL version.
- Backups and a successful restore drill.
- TLS certificate verification and database encryption-at-rest confirmed by the platform owner.
- Least-privilege grants verified from the runtime role, not a database owner.
- Connection-pool sizing, statement/lock timeouts, monitoring and alerting.
- Kill-switch and cancellation fault-injection tests.
- Evidence provenance verified against the actual source providers.
- Fencing enforced at the target side-effect resource.
- Operator procedure for orphan leases, expired leases, interrupted heartbeats and ambiguous \`RUNNING\` tasks.
- Security review of host authentication, key rotation/retirement and audit retention.

## 8. Not done

This branch does not deploy, merge, activate a worker, connect a production database, register provider adapters, rotate secrets, change access permissions or write to external repositories. The PR remains draft until code review and exact-head CI evidence are complete.
