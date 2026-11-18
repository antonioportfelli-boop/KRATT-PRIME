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
7. Only after intent commit, dispatch with the stable idempotency key.
8. Append a durable outcome event. If outcome persistence fails after provider dispatch, return `OUTCOME_UNRECORDED`; do not claim success or automatically retry.

## Durable command-store contract

The injected `commandStore` must implement:

- `appendDecision(record)`: append a denied/blocked decision.
- `commitAuthorizedIntent({ idempotencyKey, taskId, record })`: in one database transaction, verify the task is not cancelled, claim a unique idempotency key, and append the intent audit record. Return true only for a new committed intent.
- `appendOutcome({ idempotencyKey, record })`: append a completion/failure record with a unique event ID.

This module intentionally ships no fake production database adapter. A production implementation must use a durable transactional database, unique constraints, append-only audit permissions, and tested crash recovery. The existing SQLite nonce store remains a separate one-time approval nonce boundary; a future database adapter may combine nonce consumption and intent commit in a single transaction.

## Provider adapter contract

An adapter is injected explicitly by provider ID and must implement `dispatch({ task, principal, idempotencyKey })`. It must enforce least-privilege credentials and honor the supplied idempotency key at the provider boundary. No provider adapters are registered by default and no network call is performed by this module.

Adapter results are reduced to a small allowlisted audit projection: status, provider reference, and SHA-256 result digest. Secrets and arbitrary provider payloads are never copied into the audit record.

## Failure semantics

- Authentication, task validation, trusted-context loading, policy, evidence, approval, adapter lookup, and intent persistence failures prevent dispatch.
- Duplicate idempotency claims prevent a second dispatch.
- Provider errors create a durable failure outcome.
- Failure to persist an outcome after dispatch is surfaced distinctly; the system does not report success.
- External exactly-once effects cannot be guaranteed by this module alone. Providers must honor idempotency keys, and operators must reconcile intents without outcomes.

## Security boundary

The runtime is an orchestration boundary, not an identity provider, key manager, database, or provider implementation. Trusted public keys and nonce stores remain deployment-controlled. No production credentials, production adapters, deployments, or writes are enabled by this commit.
