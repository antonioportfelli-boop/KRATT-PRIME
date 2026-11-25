# Construction Reflection Recovery Journal v1

Status: isolated feature-branch implementation. Requires host-side provenance verification and a PrimeStore-compatible journal adapter.

## Scope

This module adds persistence and recovery around the existing pure `reflectConstructionTask` function. It does not replace the existing evidence kernel, durable evidence repository, or worker lease coordinator.

## Record lifecycle

1. Verify construction-task history with `verifyConstructionTask`.
2. Normalize the observation fields consumed by the reflection engine.
3. Produce a deterministic reflection report.
4. Derive an idempotency key from task identity, revision, task digest, and observation digest.
5. Append the record through a store adapter exposing `open`, `put`, `readAll`, and `verify`.
6. On duplicate writes, read the existing record and reject a digest mismatch.
7. Recovery verifies the journal, validates record digests, and returns records without dispatching follow-up work.

## Trust boundary

Observations must be provenance-verified by a trusted host before they are passed to this module. The module stores the observation digest and the reflection report; it does not independently authenticate evidence, execute code, enqueue jobs, authorize repository writes, or deploy.

## PrimeStore compatibility

The adapter shape matches the local PrimeStore contract:
- `put({ idempotencyKey, key, value })`
- `readAll()`
- `verify()`
- `open()`

A caller may inject the existing PrimeStore implementation when it is available in the same composition root. This module does not import an unmerged runtime branch.

## Validation

Regression tests cover append/recovery, idempotent replay, changed observations, malformed records, and invalid task history. Tests have been authored but were not executed in this environment. No CI result is claimed.
