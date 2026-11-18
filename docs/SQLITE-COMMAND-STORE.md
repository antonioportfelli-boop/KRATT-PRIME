# KRATT SQLite Command Store v1

## Purpose

Provide a concrete single-host durable implementation for the command-store contract consumed by `createAuthorizedDispatchRuntime`. It uses Node's synchronous SQLite API (`node:sqlite` DatabaseSync) or a compatible synchronous driver such as better-sqlite3.

## Atomic guarantees

- `commitAuthorizedIntent` uses `BEGIN IMMEDIATE` to check the task cancellation table, claim a unique idempotency key, and append the intent audit event in one transaction.
- A cancelled task, duplicate idempotency key, invalid event, or audit insertion failure rolls back the entire intent transaction.
- `appendOutcome` only accepts an existing committed intent and atomically appends the outcome plus updates the intent status.
- `cancelTask` atomically records the cancellation and a cancellation audit event. SQLite's write lock serializes cancellation and intent-commit transactions.
- The audit table has update/delete triggers that enforce append-only writes through ordinary SQL statements.
- Each audit event is linked to the prior event with SHA-256; `verifyAuditChain` detects sequence gaps, record mutation, or broken hash links.

## Limits

This is a single-host SQLite adapter, not a multi-host distributed lock or a tamper-proof external archive. An administrator able to replace the database file or drop triggers can alter it; hash-chain verification detects record-level tampering only while a trusted checkpoint of the latest hash is retained separately. Backups and external checkpointing remain operational requirements.

The existing SQLite approval nonce store remains separate. Because the policy runtime is synchronous, nonce consumption happens before this async command-store transaction. If intent commit fails, no provider dispatch occurs, but the approval nonce is burned and a new approval is required.

## Deployment status

No database file is created in this repository, no production database is configured, and no provider adapter is registered. The module is a reusable adapter with isolated temporary-database tests only. Multi-host production must supply a shared transactional implementation with equivalent unique constraints, cancellation ordering, and append-only audit semantics.
