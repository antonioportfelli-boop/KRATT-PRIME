# Integration Capability Registry v1

Status: IMPLEMENTED POLICY PRIMITIVE — NOT A PROVIDER RUNTIME

## Purpose

A deterministic, fail-closed capability decision primitive for the KRATT integration gateway. It complements the authorized-dispatch and integration-governance contracts. It does not authenticate callers, verify signatures, persist approvals, resolve credentials or call external providers.

## Descriptor

Each registered integration has stable IDs, a non-secret account reference, lifecycle state, disjoint read/write capabilities, resource allow/deny scopes, verification/evidence references and an opaque credential reference. Secret material is rejected.

## Decision sequence

1. Require complete trusted policy context.
2. Validate descriptor, lifecycle, operation and request structure.
3. Block disabled, error, discovered and unverified integrations.
4. Require exact provider and resource target matching.
5. Intersect server-derived principal, agent and connector grants.
6. Permit reads only from a verified lifecycle state and matching read scopes.
7. Permit writes only from WRITE_ENABLED with matching write scopes and an exact request-bound approval.
8. Check provider, operation ID, target, request ID and expiry on approval.
9. Require a destructive approval marker for destructive operations.
10. Emit only a minimal audit projection.

## Trust boundary

The \`approval.verified\` property must be produced by a trusted server-side cryptographic verifier; it is not proof by itself and must never be accepted from a browser or provider payload. Likewise, principal, agent and connector scopes must be loaded server-side.

A production composition root still needs signature verification, key lifecycle, revocation and replay storage, trusted context loading, durable command/audit storage, credential brokering, provider idempotency and crash recovery.

## Test coverage

The unit tests cover descriptor immutability, secret-field rejection, read/write separation, scope intersection, lifecycle blocking, target scope, provider mismatch, missing/unverified/mismatched/expired approval, destructive approval and minimal audit projection.

## Non-goals

A passing unit suite is not security certification or production readiness. This increment does not implement network access, credential resolution, external writes, multi-host guarantees, exactly-once effects, a red-team assessment or deployment.
