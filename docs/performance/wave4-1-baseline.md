# Wave 4.1 — end-to-end benchmark profile

## Purpose

This benchmark measures the real KRATT authorized-dispatch composition with a synthetic external-write task. The policy engine, request-bound approval verification, evidence-record validation, Ed25519 approval and evidence signature checks, SQLite command/audit store, and durable intent/outcome path are real repository components.

The provider adapter is deliberately mocked. No network request or external write is performed. SQLite writes go to a temporary local database file configured for WAL and `synchronous=FULL`; the database is verified using the store's audit-chain verifier after each scenario.

## Matrix and repeated measurements

The default matrix crosses evidence counts `1, 8, 32, 128` with logical in-process concurrency `1, 4, 16, 64`. Each combination has a warmup phase and three measurement rounds by default. Each round submits the configured number of operations. The JSON records per-round throughput plus the mean, standard deviation, and coefficient of variation across rounds.

Each scenario writes one JSON file to `benchmarks/results/`. The JSON records the commit SHA supplied by GitHub Actions, Node version, platform, architecture, timestamp, evidence count, concurrency, warmup and measurement counts, latency percentiles across operations, throughput, round-to-round variability, errors, memory, RSS, process CPU time, event-loop delay, measured stages, and audit-chain verification.

## What is and is not measured

Measured stages include task-envelope validation, canonical request serialization, the KRATT task digest, trusted policy evaluation, Ed25519 evidence verification, SQLite intent persistence, mocked provider execution, and SQLite outcome persistence.

The 1/4/16/64 values are logical in-flight concurrency levels within one Node.js process. They do not imply CPU-parallel JavaScript execution or multi-process worker coordination.

This profile does **not** measure PostgreSQL outbox throughput, queue admission/wait time, `governed-execution` worker leases, cancellation, crash recovery, cross-process fencing, a configured end-to-end deadline, retry behavior, or real provider latency. It must not be used to claim those paths are integrated or distributed-safe. Those need separate live-storage and multi-process test profiles.

## Running

Run the complete profile with:

`npm run bench:runtime`

Optional environment variables:

- `KRATT_BENCH_ITERATIONS` — measured dispatches in each round; default 100.
- `KRATT_BENCH_WARMUP` — warmup dispatches per scenario; default 10.
- `KRATT_BENCH_ROUNDS` — number of repeated measurement rounds; default 3.
- `KRATT_BENCH_EVIDENCE_COUNTS` — comma-separated subset of `1,8,32,128`.
- `KRATT_BENCH_CONCURRENCY` — comma-separated subset of `1,4,16,64`.
- `KRATT_BENCH_OUTPUT_DIR` — alternate output directory.

CI runs a 4x4 smoke matrix with 25 dispatches per round, 3 rounds, and 5 warmup dispatches. It uploads JSON files as a workflow artifact. Smoke results validate the harness and contracts; the short CI sample is not a controlled hardware baseline and must not be compared as a performance improvement claim.
