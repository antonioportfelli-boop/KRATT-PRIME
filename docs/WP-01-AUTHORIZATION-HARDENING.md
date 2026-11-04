# KRATT PRIME — WP-01 Authorization Hardening

Status: WP-01 IMPLEMENTED ON FEATURE BRANCH; RUNTIME TESTS NOT YET VERIFIED
Baseline: `ed31e746d1820228cd8339b86e8957a6820dbc21`
Branch: `feature/wp01-authorization-hardening`
Scope: `packages/kratt-core/src/`, its tests, and the pull-request CI test invocation. No platform adapters, production executors, external writes, credentials, or deployments.

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

## WP-01A — Trusted Approval Engine

The feature branch now exposes `createRequestBoundApprovalVerifier({ verifySignature, consumeNonce, now })`, `canonicalApprovalPayload(artifact)`, and the server-side `createTrustedAuthorizationRuntime({ trustedApprovalKeys, nonceStore, verifyEvidence, now })` composition root.

- Approval artifacts bind schema version, approval ID, task ID, actor, provider, exact operation, exact resource target, SHA-256 digest of the complete canonical task envelope (including constraints), nonce, issue/expiry timestamps, decision, approver, authority, and signature.
- The verifier rejects malformed objects, mismatched bindings, non-APPROVE decisions, expired/future approvals, and approval lifetimes longer than five minutes.
- Signature verification is delegated to a trusted synchronous `verifySignature` callback. It must validate a real signature against provisioned trusted key material; the repository does not provision keys or claim to implement a production cryptographic verifier.
- Replay protection is delegated to a trusted synchronous `consumeNonce` callback. Production must implement atomic, durable, shared nonce consumption; missing, failed, or replayed nonce consumption denies approval.
- The evaluator requires an explicit provider for external writes and accepts only the structured approval artifact. Caller booleans are not approval evidence.
- Actions without an explicit side-effect class are treated as read-only only when their terminal action is in a narrow read-only allowlist; every other unknown action defaults to EXTERNAL_WRITE.
- Test fixtures use a deliberately synthetic signature callback and in-memory nonce set. They validate the policy boundary, not production cryptography, durable replay protection, or deployment readiness.

## WP-01B — Trusted Composition Root

- The trusted runtime accepts a deployment-controlled Ed25519 public-key registry. Each key is bound to one approver identity and an explicit list of approval authorities; unknown keys, unknown authorities, wrong approver identities, malformed signatures, and invalid key types fail closed.
- Approval artifacts now include a signed `key_id`, so key selection is part of the canonical approval payload and cannot be swapped without invalidating the signature.
- Signature verification uses Node.js `crypto.verify` with Ed25519 and canonical UTF-8 approval payload bytes. The runtime does not generate or provision keys and stores no private key material.
- The composition root requires explicit trusted key configuration, a trusted evidence verifier, an injected clock, and a nonce-store adapter. There is no default approval keyring or default nonce store.
- The current policy evaluator is synchronous. The nonce adapter must synchronously perform an atomic durable shared-store consume operation; Promise-returning adapters are rejected. No production database adapter is included yet.
- Keyring configuration is snapshotted at runtime creation. Rotation or revocation requires rebuilding the runtime from the authoritative deployment-controlled key registry; hot reload and revocation propagation remain open.
- Runtime tests generate ephemeral Ed25519 keys only inside test fixtures. They do not provision production keys or establish operational key custody.
- The main CI workflow now invokes `npm test` so the KRATT core contract suite is included alongside typecheck and build when GitHub runners execute jobs.

## Implementation boundaries

- Do not treat caller-supplied evidence as verified merely because its enum says `VERIFIED`.
- Introduce a verifier boundary whose trusted result is produced outside the request payload.
- Keep pure policy evaluation deterministic and injectable with a trusted clock.
- Production composition roots must supply the Ed25519 key registry, key rotation/revocation lifecycle, trusted time, independent evidence verification, and atomic durable nonce storage before any external write can be enabled.
- Preserve the existing task/evidence schema during the first hardening increment where feasible.
- Any schema migration must be additive, versioned, tested, and documented.
- Do not enable external write execution as part of WP-01.
- Existing AURA, STEEL, FRAME.9, CERBERUS, GOLIATH OS and Trinity Edge code remains in scope for future coordinated development; do not remove or relocate it based on repository ownership alone.

## Rollback

Revert the WP-01 feature-branch commit(s) only. Do not reset or force-update shared branches. Keep test evidence and audit records.
