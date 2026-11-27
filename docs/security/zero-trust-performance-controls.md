# KRATT PRIME — Zero Trust, Performance and Evidence Controls

**Status:** implementation notes for feature-branch validation; not a certification.

## Evidence-based foundations

- NIST SP 800-207: resource-centric Zero Trust; network location is not authority. Every access request is authenticated and authorized before reaching the protected resource.
- OWASP ASVS 5.0, V8 and V16: least privilege, explicit authorization rules, security-event coverage, tamper protection, and privacy-aware logging.
- OpenTelemetry semantic conventions: consistent names and dimensions for traces, metrics, logs and events.

## Code delivered in this slice

- `canonical-request.mjs`: deterministic data-only serialization and SHA-256 fingerprinting with bounds on bytes, depth, node count, arrays and keys. It rejects accessors, sparse arrays, exotic objects, cycles, non-finite numbers and prototype-pollution keys.
- `security-telemetry.mjs`: dependency-free, bounded-cardinality counters/latency summaries and structured security events. Telemetry is never an authorization source and sink failure cannot grant or block a write.
- `bench/throughput.mjs`: reproducible canonicalization microbenchmark emitting p50/p95/p99, mean and useful operations/s, along with runtime and workload metadata.

## Integration constraints

1. Keep the existing WP-01 authorization runtime authoritative. A fingerprint identifies a request; it is not an approval and cannot replace signature verification, nonce consumption, evidence verification or trusted context checks.
2. Include actor, target, action, provider and policy version in any request-cache key. Never cache an authorization ALLOW across request IDs, scopes, policy versions or approval nonces.
3. Keep all queue limits, worker limits, deadlines and payload limits explicit at the calling boundary. This slice does not change existing queue implementations.
4. Use audit persistence as the authority for durable outcomes. Telemetry is supplementary and lossy by design.
5. Do not put raw payloads, credentials, tokens, personal data, full repository contents or approval artifacts into telemetry.
6. Benchmark before claiming speedups. Compare on the same machine, Node version, workload and concurrency; include variance and cold/hot conditions.

## Validation

Run:

```sh
node --test packages/kratt-core/test/*.test.mjs packages/kratt-orchestrator/test/*.test.mjs
KRATT_BENCH_ITERATIONS=20000 node packages/kratt-core/bench/throughput.mjs
```

The benchmark is a microbenchmark, not a system throughput claim. It does not measure database durability, network dispatch, queue contention, end-to-end authorization, or multi-tenant isolation.

## Acceptance before production

- Run repository-wide test/build/typecheck on Node 22.
- Add integration tests using the real trusted runtime and durable store, including expiry, replay, scope mismatch, cancellation, database outage and restart.
- Verify that security events are retained by the audit store separately from operational metrics.
- Run a threat-model review and an independent ASVS-based verification.
- Require human approval for all write-capable adapters and production changes.

No deployment, migration, privilege change, secret operation or production write is authorized by this document.
