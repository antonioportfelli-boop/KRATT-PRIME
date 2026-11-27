# Wave 4.1 — measured end-to-end results

Date: 2026-11-27  
Repository: `antonioportfelli-boop/KRATT-PRIME`  
Feature branch: `feature/wave4-performance-security-hardening-2026-11-27`  
Workflow run: [46022439191](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46022439191)  
Workflow artifact: `kratt-wave4-1-benchmark-e88e4976c1de5d34f5d3368bea1b215dcd759df1`  
Artifact SHA-256: `f40318c85bfc49819f9c68a78f8173fb6cc5806cf521cc85f25c2a4718310791`

## Environment and test definition

- Node.js `v22.23.5`
- Linux x64 GitHub-hosted runner; 4 reported CPUs
- 16 workload profiles: evidence counts 1, 8, 32, 128 × logical in-process concurrency 1, 4, 16, 64
- 5 warmup tasks and 3 measurement rounds × 25 tasks = 75 measured tasks per profile
- Temporary local SQLite file; WAL mode; `synchronous=FULL`
- Real KRATT task/policy/approval path and ephemeral Ed25519 approval/evidence signatures
- Mock provider only; no network or external write
- JSON `commit_sha` matches the exact feature-branch head `e88e4976c1de5d34f5d3368bea1b215dcd759df1`

Every one of the 16 profiles completed 75/75 dispatches successfully, reported 0 runtime errors, and passed the SQLite audit-chain verification.

## Results

Throughput is the arithmetic mean of the three per-round successful-operation rates. Latency percentiles are calculated from the 75 measured task latencies combined. CV is the coefficient of variation of the three round-throughput values.

| Evidence records | Concurrency | Mean round ops/s | p50 ms | p95 ms | p99 ms | Throughput CV |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 391.58 | 2.56 | 3.83 | 5.92 | 9.49% |
| 1 | 4 | 487.34 | 8.27 | 10.40 | 10.44 | 6.86% |
| 1 | 16 | 486.43 | 33.44 | 33.60 | 33.60 | 3.38% |
| 1 | 64 | 508.16 | 49.65 | 53.67 | 53.68 | 7.28% |
| 8 | 1 | 315.49 | 3.10 | 3.94 | 4.56 | 2.37% |
| 8 | 4 | 318.14 | 12.66 | 15.62 | 15.62 | 3.91% |
| 8 | 16 | 311.24 | 51.53 | 55.51 | 55.51 | 2.28% |
| 8 | 64 | 332.77 | 77.92 | 79.80 | 79.81 | 6.79% |
| 32 | 1 | 153.13 | 6.48 | 7.30 | 7.60 | 1.63% |
| 32 | 4 | 153.57 | 26.07 | 27.00 | 27.00 | 0.45% |
| 32 | 16 | 154.66 | 102.90 | 105.45 | 105.45 | 1.22% |
| 32 | 64 | 156.92 | 159.71 | 161.76 | 161.76 | 1.37% |
| 128 | 1 | 46.07 | 21.06 | 26.47 | 27.50 | 2.02% |
| 128 | 4 | 45.81 | 84.30 | 106.18 | 106.19 | 3.55% |
| 128 | 16 | 47.86 | 334.47 | 338.31 | 338.31 | 0.74% |
| 128 | 64 | 48.12 | 518.36 | 523.09 | 523.10 | 0.49% |

## Stage observations

For the 128-evidence / concurrency-1 profile:

- Evidence signature verifier: 9,600 observations, mean 0.1402 ms per record.
- Full authorization-policy evaluation wrapper: 75 observations, mean 20.46 ms, p50 19.87 ms, p95 25.16 ms.
- Canonical request serialization: mean 0.0138 ms.
- Canonical task digest: mean 0.0359 ms.
- Task envelope validation: mean 0.0188 ms.
- SQLite intent persistence: mean 0.5219 ms.
- SQLite outcome persistence: mean 0.4516 ms.
- Mock provider execution: mean 0.0005 ms.

The policy-evaluation wrapper includes more than raw signature verification; its duration must not be attributed solely to Ed25519. Stage measurements are nested observations, not additive exclusive buckets.

For the same 128-evidence / concurrency-1 profile, CPU was approximately 21.49 ms per successful operation. This is a single-run host-level cost measure, not a cross-machine estimate.

## Interpretation and limitations

1. This is a repeatable engineering baseline on a GitHub-hosted runner, not controlled hardware performance certification. A fixed dedicated runner and longer runs are still required for release-grade comparisons.
2. Three rounds × 25 tasks provide 75 latency observations per profile. Throughput CV ranged from 0.45% to 9.49% in this run; those values are more stable than the previous run but do not establish a sustained production distribution.
3. The evidence count increases policy work and reduces aggregate throughput in this workload. At 128 records, measured evidence verification and policy evaluation are material. This identifies a profiling target, not proof that an index or cache is safe or beneficial.
4. Logical concurrency values are in-process overlapping async dispatch calls. They are not worker threads, processes, machines, or cross-host concurrency.
5. The monitorEventLoopDelay histogram initially lacked a sample-count field. A subsequent benchmark revision records sample_count; event-loop percentiles from this artifact must therefore be treated as diagnostic only and not used as a statistically valid tail estimate.
6. The benchmark does not measure PostgreSQL outbox throughput, queue admission/wait, worker leases, distributed fencing, cancellation, crash recovery, retry/dead-letter, or real provider latency.
7. No before/after optimization comparison exists yet. No performance improvement is claimed.

## Provenance correction

The first three-round artifact from the earlier PR run recorded GitHub's synthetic pull-request merge SHA instead of the feature-branch HEAD. The benchmark now prefers the explicit `KRATT_COMMIT_SHA` passed by the workflow. This artifact's JSON commit SHA matches the feature branch head used for the workflow run.

## Next measurement gate

Before optimization, run a controlled longer profile on a fixed Node 22 runner/hardware with more repeated rounds and enough tasks for meaningful p95/p99 estimates. Retain identical workload, storage durability settings, evidence signatures, and provider stub. Then compare one candidate optimization at a time and rerun the full security regression suite.
