# KRATT PRIME — WP-01 Authorization Hardening

Status: IMPLEMENTATION PLAN / ACCEPTANCE GATES
Baseline: `ed31e746d1820228cd8339b86e8957a6820dbc21`
Branch: `feature/wp01-authorization-hardening`
Scope: `packages/kratt-core/src/` and its tests only. No platform adapters, production executors, external writes, credentials, or deployments.

## Threats addressed

1. Request-bound approval must bind provider, operation, target, actor/task, nonce, and expiry.
2. A caller-provided `result: VERIFIED` is an untrusted claim, not a trusted verification.
3. External writes fail closed when approval or independently verified evidence is absent.
4. Cancellation and kill-switch state override prior allows.
5. Multiple applicable policy rules must be evaluated deterministically; contradictions block.
6. Trusted context and approvals must have bounded freshness.
7. Repository branch/path scopes must be checked against canonicalized targets.
8. Effective task scope must be the intersection of principal, parent agent, child agent, connector, task, and resource scope.
9. Event IDs must be idempotent; duplicate event delivery is rejected.
10. Memory and Saga histories must detect mutation and corruption; current in-memory adapters remain explicitly non-durable.

## Acceptance gates

| ID | Scenario | Required result |
|---|---|---|
| WP01-01 | Caller fabricates VERIFIED evidence | DENY / BLOCKED |
| WP01-02 | External write has empty required evidence | DENY |
| WP01-03 | Approval missing | DENY |
| WP01-04 | Approval provider mismatch | DENY |
| WP01-05 | Approval operation mismatch | DENY |
| WP01-06 | Approval target mismatch | DENY |
| WP01-07 | Approval expired | DENY |
| WP01-08 | Approval nonce reused | REJECT |
| WP01-09 | Task cancelled after evaluation | DENY |
| WP01-10 | Trusted context expired | BLOCKED |
| WP01-11 | Contradictory applicable policy rules | BLOCKED |
| WP01-12 | Branch or path outside allowed scope | DENY |
| WP01-13 | Child scope exceeds parent scope | DENY |
| WP01-14 | Global kill switch active | DENY |
| WP01-15 | Duplicate event ID | REJECT |
| WP01-16 | Memory record tampered | DETECT |
| WP01-17 | Saga event history mutated | DETECT |
| WP01-18 | Valid request-bound approval | ALLOW only for the exact bound operation |

## Implementation boundaries

- Do not treat caller-supplied evidence as verified merely because its enum says `VERIFIED`.
- Introduce a verifier boundary whose trusted result is produced outside the request payload.
- Keep pure policy evaluation deterministic and injectable with a trusted clock.
- Preserve the existing task/evidence schema during the first hardening increment where feasible.
- Any schema migration must be additive, versioned, tested, and documented.
- Do not enable external write execution as part of WP-01.
- Existing AURA, STEEL, FRAME.9, CERBERUS, GOLIATH OS and Trinity Edge code remains in scope for future coordinated development; do not remove or relocate it based on repository ownership alone.

## Rollback

Revert the WP-01 feature-branch commit(s) only. Do not reset or force-update shared branches. Keep test evidence and audit records.
