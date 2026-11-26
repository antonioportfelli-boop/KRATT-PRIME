# KRATT Authorized Dispatch Runtime v1

## Scope

This increment composes the existing KRATT trusted authorization runtime with an asynchronous provider-dispatch boundary. It does not replace policy evaluation, Ed25519 approval verification, SQLite nonce persistence, or evidence verification.

## Execution sequence

1. Authenticate the caller through a server-owned session/identity provider.
2. Require the authenticated principal ID to equal the task actor.
3. Load trusted policy context and evidence from server-owned repositories; never accept caller-supplied evidence as verified.
4. Run the existing trusted authorization runtime. Invalid, stale, cancelled, insufficient-evidence, or unapproved tasks fail closed.
5. Resolve an explicitly registered provider adapter. Missing adapters remain blocked.
6. Atomically commit the authorization intent in the durable command store. The store must reject cancelled tasks and duplicate idempotency keys in the same transaction as appending the immutable intent audit event.
7. Obtain a second durable `beginAuthorizedDelivery` fence. It must atomically re-check cancellation and the committed intent, persist a one-time delivery-start record, and return an opaque delivery token. A missing/denied fence blocks the provider call.
8. Only after delivery-start commit, dispatch with the stable idempotency key. The delivery token is never sent to the provider.
9. Append an outcome bound to the delivery token. A verified success becomes `COMPLETED`; a known failure may become `FAILED`; a timeout, malformed response or unverifiable provider result becomes `dispatch.reconcile_required`, not a guessed failure. If outcome persistence fails, return `OUTCOME_UNRECORDED` and do not retry automatically.

## Durable command-store contract

The injected `commandStore` must implement:

- `appendDecision(record)`: append a denied/blocked decision.
- `commitAuthorizedIntent({ idempotencyKey, taskId, record })`: in one database transaction, verify the task is not cancelled, claim a unique idempotency key, and append the intent audit record. Return true only for a new committed intent.
- `beginAuthorizedDelivery({ idempotencyKey, taskId, actorId, at })`: in a second transaction, re-check cancellation and intent state, persist exactly one immutable delivery-start record and audit entry, and return an opaque delivery token. Deny duplicates.
- `appendOutcome({ idempotencyKey, deliveryToken, record })`: require the exact persisted delivery token and append a completion, failure or reconciliation-required event. Unknown outcomes must leave the intent open for manual reconciliation.

This module intentionally ships no fake production database adapter. A production implementation must use a durable transactional database, unique constraints, append-only audit permissions, and tested crash recovery. The existing SQLite nonce store remains a separate one-time approval nonce boundary; a future database adapter may combine nonce consumption and intent commit in a single transaction.

## Provider adapter contract

An adapter is injected explicitly by provider ID and must implement `dispatch({ task, principal, idempotencyKey })`. It must enforce least-privilege credentials and honor the supplied idempotency key at the provider boundary. No provider adapters are registered by default and no network call is performed by this module.

Adapter results are reduced to a small allowlisted audit projection: status, provider reference, and SHA-256 result digest. Secrets and arbitrary provider payloads are never copied into the audit record.

## Failure semantics

- Authentication, task validation, trusted-context loading, policy, evidence, approval, adapter lookup, and intent persistence failures prevent dispatch.
- Duplicate idempotency claims prevent a second dispatch.
- A provider response that cannot prove success or non-execution is an unknown outcome, not a definitive failure; it is recorded as `dispatch.reconcile_required` and cannot be blindly re-dispatched.
- Failure to persist an outcome after dispatch is surfaced distinctly; the system does not report success.
- External exactly-once effects cannot be guaranteed by this module alone. Providers must honor idempotency keys, and operators must reconcile intents without outcomes.

## Security boundary

The runtime is an orchestration boundary, not an identity provider, key manager, database, or provider implementation. Trusted public keys and nonce stores remain deployment-controlled. No production credentials, production adapters, deployments, or writes are enabled by this commit.


## SQLite implementation

A concrete single-host implementation is provided by `packages/kratt-core/src/sqlite-command-store.mjs`. It uses SQLite transactions to atomically check cancellation, claim the idempotency key, and append the intent audit event. Outcome append and intent status update are also atomic. The audit table rejects ordinary UPDATE/DELETE statements and maintains a SHA-256 hash chain. See [SQLITE-COMMAND-STORE.md](./SQLITE-COMMAND-STORE.md) for limits and operational requirements.

The SQLite adapter now persists a one-time delivery-start record/token and checks task cancellation in the same `BEGIN IMMEDIATE` transaction. Once delivery start is recorded, cancellation is refused and outcome append requires the exact token. An unknown provider outcome remains `INTENT_COMMITTED` with a reconciliation audit event; duplicate starts remain blocked. The adapter is not configured with a production database in this repository. Multi-host deployments must supply a shared transactional adapter with equivalent semantics.
