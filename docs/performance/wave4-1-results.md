# Wave 4.1 — measured end-to-end results

Date: 2026-11-27  
Repository: `antonioportfelli-boop/KRATT-PRIME`  
Feature branch: `feature/wave4-performance-security-hardening-2026-11-27`  
Workflow run: [46021742880](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742880)  
Workflow artifact: `kratt-wave4-1-benchmark-663cac4c3a500812b5b6d096fccb398caad7a7da`  
Artifact SHA-256: `7646ead2dd083dbd167f4ad9fbebd12d26156dfdd448d5a1e72bb8f344fb1150`

## Environment and test definition

- Node.js `v22.23.5`
- Linux x64 GitHub-hosted runner; 4 reported CPUs
- 16 workload profiles: evidence counts 1, 8, 32, 128 × logical in-process concurrency 1, 4, 16, 64
- 5 warmup tasks and 3 measurement rounds × 25 tasks = 75 measured tasks per profile
- Temporary local SQLite file; WAL mode; `synchronous=FULL`
- Real KRATT task/policy/approval path and ephemeral Ed25519 approval/evidence signatures
- Mock provider only; no network or external write

Every one of the 16 profiles completed 75/75 dispatches successfully, reported 0 runtime errors, and passed the SQLite audit-chain verification.

## Results

Throughput is the arithmetic mean of the three per-round successful-operation rates. Latency percentiles are calculated from the 75 measured task latencies combined. CV is coefficient of variation of the three round-throughput values.

| Evidence records | Concurrency | Mean round ops/s | p50 ms | p95 ms | p99 ms | Throughput CV |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 199.37 | 2.09 | 27.81 | 308.18 | 57.37% |
| 1 | 4 | 422.14 | 7.19 | 13.39 | 51.66 | 27.62% |
| 1 | 16 | 337.88 | 28.57 | 371.52 | 371.53 | 57.47% |
| 1 | 64 | 425.25 | 57.79 | 96.40 | 96.41 | 31.22% |
| 8 | 1 | 208.24 | 2.57 | 19.07 | 63.18 | 12.79% |
| 8 | 4 | 240.44 | 10.55 | 109.62 | 109.62 | 40.39% |
| 8 | 16 | 320.54 | 41.68 | 58.40 | 58.40 | 16.72% |
| 8 | 64 | 265.05 | 109.53 | 131.77 | 131.78 | 30.52% |
| 32 | 1 | 135.32 | 5.72 | 18.15 | 32.28 | 14.52% |
| 32 | 4 | 165.71 | 22.12 | 38.14 | 38.14 | 2.92% |
| 32 | 16 | 164.59 | 85.01 | 113.29 | 113.29 | 7.70% |
| 32 | 64 | 118.47 | 153.31 | 1231.69 | 1231.70 | 58.68% |
| 128 | 1 | 27.47 | 17.62 | 173.60 | 201.45 | 14.46% |
| 128 | 4 | 50.21 | 72.13 | 118.37 | 118.38 | 5.01% |
| 128 | 16 | 47.78 | 324.41 | 372.17 | 372.17 | 3.78% |
| 128 | 64 | 46.68 | 560.38 | 577.62 | 577.63 | 8.38% |

## Stage observations

For the 128-evidence / concurrency-1 profile:

- Evidence signature verifier: 9,600 observations, mean 0.1127 ms per record.
- Full authorization-policy evaluation wrapper: 75 observations, mean 27.09 ms, p50 16.22 ms, p95 118.70 ms.
- Canonical request serialization: mean 0.0093 ms.
- Canonical task digest: mean 0.0180 ms.
- Task envelope validation: mean 0.0115 ms.
- Mock provider execution: mean 0.0006 ms.

The authorization-policy wrapper includes more than raw signature verification; its duration must not be attributed solely to Ed25519. These are instrumented stage observations, not isolated microbenchmarks.

## Interpretation and limitations

1. This is an initial CI-hosted engineering baseline, not a controlled hardware performance certification.
2. Three rounds × 25 tasks are insufficient for stable tail latency claims. CV reaches 58.68% in one profile and exceeds 25% in several low-evidence profiles. The high p95/p99 values and run-to-run variation show that the runner is noisy.
3. Logical concurrency values are in-process overlapping async dispatch calls. They are not worker threads, processes, machines, or cross-host concurrency.
4. The benchmark measures local SQLite, not the PostgreSQL outbox. It does not measure queue admission/wait, worker leases, distributed fencing, cancellation, crash recovery, retry/dead-letter, or real provider latency.
5. No before/after optimization comparison exists yet. No performance improvement is claimed.
6. The PR-triggered workflow's first artifact JSON recorded GitHub's synthetic pull-request merge SHA (`663cac4c...`) in `commit_sha`, although the run's actual branch head was `a14c047c8f59411a25a8d8b23f0fde5cda0a3c8b`. This provenance defect is fixed in the next benchmark change by passing the pull-request head SHA explicitly as `KRATT_COMMIT_SHA`. Do not treat the JSON's synthetic SHA as the feature branch SHA.

## Next measurement gate

Before optimization, run a controlled longer profile on a fixed Node 22 runner/hardware with more repeated rounds and enough tasks for meaningful p95/p99 estimates. Retain identical workload, storage durability settings, evidence signatures, and provider stub. Then compare one candidate optimization at a time and rerun the full security regression suite.
