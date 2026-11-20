# Wave 1–10: critical gaps and trusted release gates

Branch: feature/wave1-10-trusted-evidence-gates-2026-11-20
Parent: Wave 1–10 progression alignment merge bdda0df167d529ddbb583afbbfde39482ab91f5d
Release mode: feature branch and draft review only

## Critical finding: self-asserted evidence is not trusted evidence

The local progression preview accepts records carrying verified: true. That field is caller-controlled and must never authorize a release decision. The original helper remains for local inventory previews only. This branch adds evaluateTrustedWaveGate, which requires an injected trusted verifier and independently verified completion attestations for every dependency.

The injected verifier is a trust boundary, not a convenience callback. Production wiring must validate issuer/key identity, signature algorithm, key rotation/revocation, audience, subject, wave and evidence-kind scope, immutable evidence digest, issued-at/expiry, nonce/replay state and audit provenance. If the verifier is absent, throws, times out or returns anything other than literal true, the gate denies.

## Wave 1–10 critical gap register

| Wave | Critical missing work | Buildable in repository now | External evidence still required |
|---|---|---|---|
| 01 Foundation | Schema compatibility, contract versioning, migration ownership | Canonical schema/version policy, compatibility fixtures, contract tests | Downstream consumer inventory |
| 02 Trust | Key custody, revocation, replay and request-bound approval verification | Fail-closed verifier interface, negative tests, signed-evidence envelope contract | KMS/HSM, key owners, security review |
| 03 Fabric | Canonical event schema, dedupe semantics, tenant/resource scope, read/write lifecycle | Schema registry, event compatibility tests, adapter conformance suite | STEEL protocol approval and provider credentials |
| 04 Durability | Atomicity across approval, cancellation, idempotency, outbox and audit | Transaction contract tests, lease fencing model, migration checks | Real PostgreSQL integration and failover tests |
| 05 Async + STEEL | Factory Protocol mapping, cancellation propagation, timeout semantics | Contract adapter tests against canonical STEEL schema snapshots | STEEL repo access and integration environment |
| 06 Intelligence | Source reliability, comparable units, time windows, baseline provenance, report reproducibility | Typed evidence normalization, deterministic report digest, missing-data semantics | Licensed market data and verified source provenance |
| 07 Telegram | Webhook authentication, replay resistance, source allowlist, retention and privacy | Ingress schema, signature verifier interface, replay and redaction tests | Bot token, configured webhook, channel-owner consent |
| 08 Staging | Secret injection, consent, schema preflight, network policy and rollback | Strict config parser, dry-run preflight, operator runbook | Staging DB, DNS/TLS, secret manager and operator |
| 09 Resilience | Multi-replica limits, lease expiry, crash recovery, migration locks, backup restore | Fault-injection tests and readiness contract | Multi-node staging and backup restore evidence |
| 10 Observatory | Tamper-evident chain, protected read API, projection reconciliation, retention | Trusted evidence gate, API contract tests, projection invariants | Real auth provider, DB-backed audit, staging attestation |

## Cross-wave requirements

1. One canonical schema source; no forked STEEL protocol.
2. Explicit tenant/resource scope on every event, approval, evidence, snapshot, report and operation.
3. Hash/sign canonical payload bytes with schema version and algorithm identifier.
4. Define idempotency scope, retention, duplicate response and replay window.
5. Serialize cancellation and dispatch against one durable operation state.
6. Keep secrets server-side; redact logs, UI, artifacts and errors.
7. Use correlation/trace IDs, append-only audit and explicit unknown/unbound/degraded states.
8. Ordered, checksummed, lock-protected migrations with forward-recovery plan.
9. UI states must distinguish bound, unbound, partial, disabled, denied and degraded.
10. Every wave requires independently verifiable completion evidence; unit tests alone do not prove staging readiness.

## Implementation sequence

P0: connect trusted verifier to server-owned key custody and immutable evidence storage.
P0: replace caller-supplied completion flags with signed per-wave attestations.
P0: add tenant/resource scope and request-bound approval/cancellation serialization.
P1: reconcile Wave 3 sibling PRs #27/#28 and select canonical Fabric schema.
P1: prove Wave 4 PostgreSQL transaction semantics with concurrency tests.
P1: verify STEEL Factory Protocol against canonical STEEL source.
P1: implement Telegram ingress security and privacy/retention controls.
P2: finish staging composition, migration locks, backup restore and multi-replica fault tests.
P2: bind Control Desk to protected API with server-side authorization and operator attestations.

## Cannot be completed by repository writes alone

KMS/HSM ownership, provider authorization, Telegram webhook activation, real PostgreSQL failover, DNS/TLS, licensed-data consent and staging operator sign-off require external systems and authorized people. This branch does not fabricate those facts or bypass approvals.
