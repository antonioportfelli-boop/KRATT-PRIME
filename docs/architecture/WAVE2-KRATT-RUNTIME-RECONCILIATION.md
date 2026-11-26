# Wave 2 — KRATT Runtime Operational Reconciliation

**Snapshot:** 2026-11-26  
**Base:** \`main\` at \`782373cd7760a12141c75655dd890313c30f3021\`  
**Branch:** \`feature/wave2-runtime-reconciliation-2026-11-26\`

## Executive result

KRATT main already contains a real **governed execution bridge**. The previous inventory that classified the worker lease and reflection/recovery layers as wholly absent was incomplete and has been corrected in this revision.

The mainline bridge composes:
- WP-01 authorization and request-bound approval evaluation;
- verified Evidence Cards, a provenance callback and a stable journal snapshot;
- construction-task and policy-task binding;
- a worker lease with a monotonically increasing fencing token;
- append-only execution revisions and a governance receipt;
- start, completion, failure, retry, acknowledged cancellation and read-only recovery.

However, this is not yet a general-purpose production worker fleet. The current bridge uses a local PrimeStore journal and local worker-lease coordinator. The lease coordinator explicitly documents its single-process scope. The governed bridge returns \`dispatch: false\` and \`externalEffects: false\`; it does not invoke real repository/provider side effects. Recovery never replays a worker.

## Verified mainline layers

| Layer | Mainline capability | Limitation |
|---|---|---|
| Construction task | Immutable task digest and guarded state transitions | Does not execute code |
| Execution ledger | Append-only revision history, fence validation, stale revision/fork rejection | Journal adapter must provide durable serialization |
| Trusted authorization | Existing WP-01 policy + approval/evidence verifier | Trust keyring, nonce store and principal/context loaders are deployment injected |
| Evidence projection | Durable Evidence Cards over PrimeStore | Local journal; not encrypted or cloud replicated |
| Worker leases | Lease acquire/renew/release, expiry, replay guard and monotonic fencing | One-process coordinator; not distributed mutual exclusion |
| Governed execution | Authorization → ECK evidence → lease → execution claim → receipt → start/terminal transitions | Local composition, compensation is not a multi-table atomic transaction, no external worker side effects |
| Execution recovery | Verifies journal, revision continuity and history chain; returns latest valid state | Never resumes/replays RUNNING work; operator reconciliation is required |
| PostgreSQL outbox | Shared transactional intent/nonce/cancellation/outbox library | At-least-once provider semantics; no live provider/database configured |

Relevant mainline sources:
- \`packages/kratt-runtime/src/governed-execution.mjs\`
- \`packages/kratt-runtime/src/worker-lease-coordinator.mjs\`
- \`packages/kratt-runtime/src/durable-evidence.mjs\`
- \`packages/kratt-core/src/construction-execution-ledger.mjs\`
- \`packages/kratt-core/src/prime-store.mjs\`
- \`packages/kratt-core/src/postgres-outbox-store.mjs\`

## Gaps that prevent an operational-readiness claim

1. **Local journal scope.** PrimeStore is a local append-only file journal; it is not a shared multi-process or multi-host transaction service.
2. **Lease scope.** The lease coordinator serializes operations through one shared PrimeStore object in one Node process. It explicitly disclaims cross-host mutual exclusion.
3. **No external worker executor.** Governed execution intentionally stops at state transitions and returns \`dispatch: false\`. A target must independently enforce fencing before any future side effect.
4. **Compensation window.** Lease, execution revision and governance receipt are not one transaction. Process failure can leave a bounded orphan lease; recovery must reconcile rather than guess.
5. **Host trust material.** Authentication, trusted context, trusted approval keys/nonce consumption and source provenance callbacks must be configured by the server owner. The code does not fabricate these dependencies.
6. **Recovery semantics.** A RUNNING job after a crash is not automatically retried; an operator/worker must establish whether a side effect occurred before a new approved attempt.
7. **Reflection layer.** A separate persisted reflection/recovery journal was not found in main. Existing execution recovery is not the same as a semantic reflection engine.

## Wave 2 branch implementation target

This branch adds an opt-in PostgreSQL mode while retaining the existing local mode:
- a shared hash-chained PostgreSQL journal adapter that satisfies the existing PrimeStore interface;
- a transactional PostgreSQL worker lease coordinator using row locks, stable operation IDs and monotonically increasing fencing tokens;
- an async composition factory that injects both adapters into the existing governed execution bridge;
- a schema migration, contract tests and a real PostgreSQL CI workflow.

The new backend is **not** production-certified merely because its code exists. It remains pending until the exact PR head passes ordinary CI and a live PostgreSQL 16 integration run.

## Database and operations boundary

The PostgreSQL mode must use:
- one reviewed migration path; no automatic DDL from application startup;
- a least-privilege runtime role with SELECT/INSERT on journal entries, SELECT/UPDATE on journal head, and the required lease-table DML;
- TLS and platform-managed encryption at rest;
- tested backup/restore, connection-pool limits, statement timeouts and monitoring;
- a single authoritative database clock for lease expiry;
- no network filesystem for the local PrimeStore mode.

The PostgreSQL runtime journal is append-only at the table boundary. Its hash chain detects tampering but does not replace database access control, backup integrity, external checkpoints or signing.

## Acceptance gate

Operational readiness for a **staging backend** requires:
- PostgreSQL migration applied to an isolated test database;
- real concurrency test with two independent connection pools competing for one reservation;
- stale fence, expired lease, idempotent replay, renewal, release and restart recovery tests;
- concurrent journal append and chain verification tests;
- full core tests, typecheck and application build on the exact reviewed SHA;
- a host composition that supplies trusted auth, provenance, principal/context loaders and an independently enforced kill switch.

Production use remains blocked until real worker adapters, target-side fence enforcement, crash reconciliation, security review, backup/restore and live environment evidence exist.

## Not done

No production deployment, external provider call, repository side effect, secret rotation, permission change, main-branch mutation or merge is performed by this PR.
