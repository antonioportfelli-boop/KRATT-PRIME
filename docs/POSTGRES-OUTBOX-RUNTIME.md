# KRATT PostgreSQL Outbox Runtime v1

## Scope
Wave 4 adds a shared PostgreSQL command boundary and an at-least-once outbox worker. It is library code only: no credentials, live database, provider registration, deployment, or external writes are enabled.

## Atomic reservation
The trusted caller must first authenticate the principal and verify task policy, evidence, approval signature, authority, request digest and expiry. It then calls \`reserveAuthorizedIntent\` with verifier-derived claims. One PostgreSQL transaction inserts the unique one-time nonce, checks cancellation, claims the idempotency key, creates the intent and outbox rows, and appends the audit event. Any failure rolls the transaction back.

This reservation API is deliberately separate from Wave 3's synchronous \`authorizationRuntime.evaluate\`. The Wave 3 runtime consumes its nonce before an asynchronous store call. Do not claim those separate calls are atomic. An async verifier composition root must bridge trusted verification to this transaction without exposing untrusted approval claims.

## Worker and crash recovery
Workers use \`FOR UPDATE SKIP LOCKED\`, lease tokens and lease expiry. Expired leases can be reclaimed. A provider may succeed while a worker crashes before recording the result, so delivery is **at least once**, not exactly once. Every provider adapter MUST honor the stable idempotency key. Failures use bounded exponential backoff and transition to \`DEAD\` after the configured attempt limit. Dead-letter rows require operator review.

## Integration
- Inject a node-postgres-compatible pool exposing \`connect()\`.
- Apply \`packages/kratt-core/migrations/0001_postgres_outbox.sql\` with an approved migration runner.
- No provider adapter is included or enabled by default.
- Inject a trusted UTC clock.
- Audit hash-chain head is serialized with a singleton row lock; external checkpoints and restricted database roles remain necessary.

## Verification and limits
WP-03.9 adds worker unit tests and a PostgreSQL integration case that uses the real outbox store: cancellation is committed after claim but before delivery start, and the worker must make zero provider calls. CI must execute this against PostgreSQL 16 before WP-03.9 is considered verified. No external provider endpoint is called by the test. Database durability, backups, TLS, least-privilege roles, monitoring and failover are deployment responsibilities.
