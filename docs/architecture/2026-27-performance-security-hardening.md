# KRATT PRIME — Wave 4+ Performance & Security Hardening (2026–2027)

**Status:** implementation specification / non-production  
**Branch:** `feature/wave4-performance-security-hardening-2026-11-27`  
**Base:** `782373cd7760a12141c75655dd890313c30f3021`  
**Safety:** no production deployment, no secrets, no main-branch changes.

## Objective

Increase useful, authorized information throughput while preserving request-bound authorization, provenance, immutable audit history, cancellation, and fail-closed behavior. Optimize measured work, not raw event count.

For a workload, report:
- useful completed operations per second;
- p50/p95/p99 end-to-end latency;
- queue wait, service time, and authorization/audit overhead separately;
- rejection, retry, cancellation, and recovery rates;
- resource cost per successful operation.

No performance claim is valid without a reproducible baseline, workload definition, hardware/runtime details, and repeated measurements.

## Design rules

1. **One canonical authorization decision.** Reuse the existing WP-01 evidence and scope checks; do not add a parallel permissive path.
2. **Fast-path only immutable, verified facts.** Cache capability metadata and compiled policy decisions only when keyed by policy version, actor, resource scope, and evidence digest. Never cache an approval as reusable authority.
3. **Bound all work.** Apply explicit limits to payload bytes, queue depth, retries, fan-out, deadlines, and concurrent workers. Reject before expensive parsing where safe.
4. **Persist before acknowledging durable intent.** Keep command/outbox state and audit evidence transactionally coupled. Delivery may be at-least-once; handlers must be idempotent.
5. **Cancellation is a state transition, not a best-effort signal.** Persist cancellation intent, fence stale workers, and record the terminal outcome.
6. **Separate trust domains.** Untrusted adapters and plugins run with minimal capabilities, strict egress allowlists, bounded resources, and no direct access to signing keys or audit-store internals.
7. **Fail closed on uncertainty.** Missing, stale, conflicting, or unverifiable evidence must not authorize a write.
8. **Keep observability privacy-safe.** Correlation IDs and typed outcome codes are allowed; secrets, tokens, raw sensitive payloads, and personal data are not.

## Implementation sequence

### P0 — Establish truth
- Capture the current test/build status and branch/commit identity.
- Inventory existing WP-01, execution ledger, outbox, lease, and recovery contracts before changing behavior.
- Add a threat-model-to-test traceability table; mark untested assumptions explicitly.

### P1 — Measure before optimizing
- Add repeatable benchmarks for authorization, canonicalization, durable enqueue, dispatch, cancellation, and recovery.
- Include hot-cache and cold-cache runs, contention, malformed inputs, and adversarial queue pressure.
- Store benchmark configuration and machine-readable results as CI artifacts; do not gate on noisy microbenchmarks until variance is characterized.

### P2 — Safe latency reduction
- Avoid repeated canonical serialization by computing one validated canonical representation and digest per request.
- Reuse immutable schema/policy compilation artifacts; invalidate on version change.
- Use bounded batching only for independent read/telemetry operations. Never batch across authorization scopes or combine approval decisions.
- Use bounded queues, deadline propagation, and backpressure rather than unbounded buffering.
- Keep synchronous durability at the authorization/intent boundary; measure any asynchronous work after that boundary separately.

### P3 — Resilience and isolation
- Test stale lease fencing, duplicate delivery, process restart, partial database failure, and cancellation races.
- Add fault-injection tests for storage unavailable, clock skew, invalid signatures, replay, and corrupted evidence.
- Evaluate sandboxed plugin execution only behind an explicit capability contract and kill switch; do not load untrusted kernel extensions.

### P4 — Release evidence
- Publish a signed-off test matrix, benchmark comparison, threat-model delta, rollback plan, and known limitations.
- Require human review for any write-capable adapter, production migration, or deployment.

## Acceptance gates

- Existing authorization and provenance tests remain green.
- No unauthorized, expired, replayed, wrong-scope, or unverifiable request reaches a write side effect.
- Idempotency and audit invariants hold across retry, crash/restart, and concurrent dispatch.
- Every queue, payload, retry loop, and worker pool has an explicit bound.
- Performance changes show repeatable improvement in p95/p99 or useful throughput without weakening security checks.
- Benchmark results include environment, commit SHA, workload, sample count, and variance.
- Main branch and production remain untouched until a reviewed release decision.

## Research anchors

- NSA Zero Trust Implementation Guides announcement (2026-05-28): modular implementation across identity, device posture, infrastructure, data, network segmentation, automation, and analytics. https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4496862/nsa-launches-zero-trust-implementation-guidelines-resource-webpage/
- CISA/partners OT Zero Trust guidance (2026-04-29): asset visibility, supply-chain risk, identity/access, zones/conduits, and operational safety. https://content.govdelivery.com/accounts/USDHSCISA/bulletins/4151784
- CISA cyber-decoy guidance (2026-09-16): high-fidelity detection and response as a complement to Zero Trust, not a replacement. https://www.cisa.gov/news-events/news/new-cisa-guidance-helps-critical-infrastructure-detect-observe-and-impede-malicious-cyber-activity
- USENIX OSDI ’26 eBPF late-binding research: reported up to 3.9× latency reduction and 29% throughput improvement in its evaluated workloads; treat as research evidence, not a guaranteed KRATT result. https://www.usenix.org/conference/osdi26/presentation/zhang-jing
- NIST SP 1800-35: practical Zero Trust architecture implementations and mappings to NIST security guidance. https://csrc.nist.gov/News/2025/implementing-a-zero-trust-architecture-sp-1800-35

## Explicit non-goals

This document does not claim national-security certification, production readiness, measured speedup, or successful test execution. It does not authorize deployment, secret rotation, privilege changes, or unreviewed external writes.
