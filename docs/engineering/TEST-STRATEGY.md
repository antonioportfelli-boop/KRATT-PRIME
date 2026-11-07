# Test Strategy and Acceptance Evidence

## Test pyramid
1. Unit: schema validation, canonicalization, policy rules, memory operations and Saga transitions.
2. Contract: adapter input/output schemas, idempotency and error semantics.
3. Integration: real database transactions, webhook ingress, worker dispatch and audit persistence.
4. Security: forged evidence, approval replay, scope escalation, path traversal, prompt injection and secret handling.
5. Recovery: process restart, stale leases, retries, outbox replay, backup and restore.
6. Platform: Linux, Windows and Android compatibility where supported.

## Required invariants
- Tests run against exact commit under review.
- Time is injected; tests do not depend on uncontrolled wall-clock behavior.
- Security tests include deny cases and narrowly valid allow cases.
- Concurrency tests use a real supported database, not only mocks.
- Every external side effect has a testable idempotency key.
- CI status records whether a job passed, failed, was blocked or never ran.

## Evidence record
For each run store repository, branch, commit SHA, workflow/run ID, environment, command, result, timestamp, log/artifact reference and reviewer. Redact secrets and personal data.

## No false claims
A defined test case is not an executed test. A green lint job is not a green build. A successful mock is not proof of a production integration.