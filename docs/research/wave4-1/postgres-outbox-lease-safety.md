# Wave 4.1 — PostgreSQL outbox lease validity

## Finding

The original outbox claim used one statement with FOR UPDATE SKIP LOCKED. However, finishOutbox and retryOutbox selected a row by status and lease token without checking whether lease_until had passed. An expired worker could therefore record a terminal outcome if no replacement worker had reclaimed the row yet.

## Change

- Lease acquisition and expiry eligibility now use PostgreSQL server time (NOW()) in the claim statement. The lease deadline is also derived from that database clock.
- Both finish and retry require lease_until > clock_timestamp() while acquiring the row lock. A stale or expired worker receives LEASE_LOST and cannot mutate the outbox or intent through these methods.
- Existing idempotency keys, transaction boundaries, append-only audit chain, and state names remain unchanged.

## Compatibility and security

PostgreSQL documents SKIP LOCKED as useful for queue-like tables with multiple consumers, while warning that it provides an inconsistent view and is unsuitable for general-purpose reads. Delivery remains at-least-once, not exactly-once; providers must continue honoring the stable idempotency key.

## Verification

- Contract tests assert server-clock lease checks for acquisition, finish, and retry.
- No PostgreSQL server or credentials were available; no live multi-worker, crash-recovery, or database integration test is claimed.
- Lease tokens remain per-lease UUIDs. A monotonic fencing generation that downstream providers can enforce remains a separate follow-up.

## Primary references

- https://www.postgresql.org/docs/current/sql-select.html
- https://www.postgresql.org/docs/current/explicit-locking.html
- https://www.postgresql.org/docs/current/sql-update.html
