# Wave 12 — bounded outbox throughput

**Date:** 2026-11-27  
**Branch:** feature/wave12-bounded-outbox-throughput-2026-11-27  
**Status:** implementation candidate; CI and target-database verification required

## Problem

The previous outbox worker claimed a batch and then awaited every provider call in a serial loop. The database could reserve work in a batch, but one slow provider response held up every later item in that batch.

## Change

The worker now has a configurable fixed concurrency ceiling (default 4, maximum 32). It uses a small in-process consumer pool over the already-claimed batch, retains result order by claim index, and returns aggregate processing telemetry. Provider failures are isolated to their own item and use the existing retry/lease API. The durable idempotency key is passed unchanged to every provider attempt.

## Safety properties

- No unbounded Promise fan-out and no implicit increase to the database claim limit.
- limit remains bounded to 1–100 and lease duration to 5–900 seconds.
- Concurrency is configurable only at worker construction and is bounded to 1–32.
- Adapter registry entries must be own data properties; getters and Proxy-backed registries are rejected.
- A lost lease is reported as LEASE_LOST, not as success.
- Result ordering is deterministic relative to the claimed batch, even when provider completion order differs.
- The worker does not enable a provider, resolve credentials, create approvals, or bypass the authorization transaction.
- External effects remain at-least-once. A provider must honour the stable idempotency key and implement its own bounded network timeout.

## Measurement

Each runOnce result includes durationMs, processedPerSecond, concurrency, maxInFlight, recorded, retryScheduled and leaseLost.

These are batch-local measurements, not a service-level SLO. A production deployment should export queue age, queue depth, delivery latency p50/p95/p99, retry/dead-letter rates, worker saturation, database wait time and provider error rate with OpenTelemetry-compatible low-cardinality attributes. Do not emit payloads, credentials, approval contents or personal data as metric labels.

## Validation still required

1. Run the full unit/type/build CI on this branch.
2. Run the PostgreSQL integration suite under contention and worker restart.
3. Benchmark with representative provider latencies and payload sizes; compare p50/p95/p99 latency and throughput at concurrency 1, 2, 4, 8 and 16.
4. Verify provider-specific rate limits, idempotency retention periods, timeout behaviour and lease duration against the real adapter contracts.
5. Set per-provider concurrency/rate limits before enabling any live integration.

No production database, provider endpoint, credential, staging environment, or government accreditation was used by this change.
