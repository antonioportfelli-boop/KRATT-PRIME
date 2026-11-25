# Durable worker reservations and leases (Stage 7.1)

## Scope

This stage adds a local, append-only lease coordinator on top of `PrimeStore`. It reserves a stable task key against a canonical task digest, grants bounded leases, persists renewals/releases, and increments a monotonically increasing fencing number when a lease is reacquired after expiry or release.

The component never dispatches work, starts a worker, or contacts Pico-Cloud. Lease success means only that one caller currently holds a local coordination record. It is not proof that the caller is an authenticated worker and is not authorization to execute.

`reserveWorkerProposal` connects the in-memory result of `createWorkerProposal` to the lease coordinator. It accepts only the original frozen proposal object produced by the current runtime instance; a caller-created object or a blocked proposal cannot reserve a lease through this helper. The helper still cannot authenticate the supplied `ownerId`; that identity must come from trusted server-side context.

## Contract

Use one `PrimeStore` instance and one journal path for the coordinator. Each mutation requires a unique operation ID. Repeating an identical operation ID and request returns its persisted outcome while safe; an old successful acquire/renew replay is blocked if that exact fencing lease is no longer current. Reusing an operation ID for different inputs is rejected. A reservation key is bound to one `sha256:` task digest for the lifetime of the journal. Changing the payload under the same key is rejected.

`acquire` grants a lease for 1 second through 15 minutes. A live lease blocks another acquisition. Once expired, a later acquisition advances the fence. `renew` and `release` require the current owner ID and fencing number. Stale owners and stale fencing values are denied. `release` only gives up the pre-execution reservation; it does not record task completion and must not be used as an exactly-once completion signal.

Every result carries `dispatch: false`; successful lease results also carry `executionStarted: false`. Callers must still check policy, consent, budgets, task digest and kill-switch state immediately before any future side effect. An eventual worker adapter must enforce the fence at the resource that accepts writes; checking it only in this coordinator cannot fence a stale process that already has independent access.

## Persistence and consistency limits

Operations are stored as versioned records in the existing hash-chained local journal. The coordinator serializes operations from multiple coordinator objects that share the same `PrimeStore` object within one Node.js process. PrimeStore also obtains an exclusive lock file for each append, so overlapping or stale-head writers fail before adding a journal record. A process crash can leave a lock file behind; inspect it and confirm its owner is gone before removing it manually. This append lock is not a multi-operation transaction or a cross-host lease protocol. Do not use network filesystems or infer distributed mutual exclusion from it.

Records are append-only and the log has no retention or compaction policy yet. The journal and its temporary writer-lock file are not encrypted. Protect the journal directory using host access controls. A tampered, malformed, stale or concurrently written journal causes the operation to fail rather than reconstruct a guessed state.

## Remaining gates before any execution

- Authenticated worker principals and owner identity binding from trusted server context.
- Multi-operation cross-process transactions or a reviewed single-writer service boundary.
- Completion/failure terminal states, retry semantics and durable exactly-once side-effect design (exactly-once is not claimed here).
- Fencing enforced by each side-effect target, plus kill-switch recheck and cancellation before effects.
- Leases integrated with the Stage 7 proposal and ECK audit path, while ensuring audit failure blocks any future dispatch.
- Retention, key protection, backup/restore, concurrency/fault injection and operational recovery review.

Statistical calibration, MCU algorithms and remote worker execution remain out of scope.

`reserveAndAuditWorkerProposal` records proposal intent in ECK, reserves the durable lease, then writes a lease receipt to ECK. These are not one transaction. If the receipt write fails, the helper attempts a fenced compensating release; it returns `BLOCKED` only when that release succeeds, otherwise `PARTIAL` and the lease expiry for operator reconciliation. A crash between lease persistence and its ECK receipt can leave a proposal plus an unreceipted lease until its bounded TTL expires. No dispatch path exists, and future execution must reconcile this state before it can be enabled. Retrying the exact operation (including its original timestamp) is idempotent while its lease remains current; expired replays are denied and require a new operation identifier. A `PARTIAL` result can be retried with the same lease operation while it remains current to persist the missing receipt; this retry records evidence only and does not authorize dispatch.

The local operator may expose `GET /leases/status` when `KRATT_LEASE_JOURNAL_PATH` is explicitly configured. Its response contains only aggregate counts and `dispatch: false`; it excludes reservation, owner, task, fence and expiry identifiers. It is a read-only status view, not an authorization or control endpoint.

