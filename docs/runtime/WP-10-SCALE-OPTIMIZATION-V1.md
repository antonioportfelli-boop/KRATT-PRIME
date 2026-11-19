# WP-10 — Agent scale measurement and optimization v1

**Work package:** WP-10 — Scale and optimization  
**Implementation branch:** feature/wp10-scale-optimization-v1  
**Base:** feature/durable-worker-leases-fencing-v1  
**Status:** evaluation and proposal primitives implemented; no live agent scaling or execution activation.

## Objective

Advance agent factories only when actual, source-verified observations support the change. WP-10 introduces a bounded performance-reporting contract, an advisory concurrency planner and a descriptive cohort-comparison function. It deliberately does not create more agents as a vanity metric, spawn workers, change concurrency, or dispatch tasks.

## Implemented files

- packages/kratt-runtime/src/scale-optimizer.mjs
  - strict kratt-agent-run-observation/v1 input contract;
  - injected source verifier required for every observation;
  - cohort validation by agent, environment and concurrency;
  - throughput, success/error, Wilson lower confidence bound, p50/p95 latency, cost per successful task, retry/recovery and queue-pressure metrics;
  - one-step increase/decrease proposals with operator-supplied limits;
  - descriptive baseline/candidate deltas.
- packages/kratt-runtime/test/scale-optimizer.test.mjs
  - positive, malformed, unverified, insufficient-sample, queue-pressure, guardrail and comparison tests.
- packages/kratt-runtime/src/semantic-retrieval-evaluator.mjs
  - source-verified, scope-bound retrieval evaluation;
  - precision@k, recall@k, MRR, nDCG@k, verified-result coverage and unverified/scope-contamination metrics;
  - a shadow-only quality gate.
- packages/kratt-runtime/test/semantic-retrieval-evaluator.test.mjs
  - provenance, ranking, scope, duplicate, missing-result and shadow-gate tests.

## Agent-run observation contract

Every observation is a closed object with:

| Field | Meaning |
|---|---|
| observationId, agentId, taskId | Stable identifiers; duplicates are rejected |
| environment | Local/staging/canary cohort identifier |
| status | SUCCEEDED, FAILED, CANCELLED, or TIMED_OUT |
| startedAt, finishedAt | UTC timestamps; duration is derived, not trusted from caller input |
| costMicroUsd | Recorded cost in integer micro-USD |
| attemptCount, recoveryCount | Bounded retry and recovery evidence |
| queueWaitMs, queueDepthAtAdmission | Measured demand/queue pressure |
| concurrencyAtStart | Actual configured concurrency for this sample cohort |
| sourceDigest | SHA-256 reference to the runtime observation source |

summarizeAgentRuns requires an injected verifyObservation callback. It fails closed when verification is absent, throws or rejects a record. Records from different agents, environments or concurrency settings cannot be mixed into one cohort. The resulting report includes a digest of the verified sample set; it does not retain task payloads.

## Scale-proposal rules

proposeAgentScale requires explicit operator thresholds for sample count, success and error rates, confidence lower bound, p95 latency, unit cost, recovery rate, queue wait/depth and min/max concurrency.

- Increase: only when the sample threshold and every quality/cost guardrail pass, and both p95 queue wait and p95 queue depth show measured pressure. The increase is exactly one concurrency step.
- Decrease: one step when reliability, latency, cost or recovery guardrails are breached and the current concurrency is above the configured floor.
- Hold: insufficient samples, no measured queue pressure, or capacity already at its configured boundary.

Every result remains PROPOSAL_ONLY (or an explicit insufficient-evidence/guardrail state). It carries policyApprovalRequired=true, dispatch=false, applied=false and executionStarted=false. A report cannot authorize a worker, mutate a pool or override the WP-01 policy boundary.

The Wilson lower bound is descriptive uncertainty information for the observed success rate. It is not a claim of calibrated model confidence, causality or guaranteed future performance. Cohort comparisons return deltas only and explicitly make no release decision.

## Semantic retrieval evaluation

Semantic memory/vector retrieval remains optional and is not activated by this work package. evaluateSemanticRetrieval accepts query digests and source-reference labels rather than raw query text. It requires the caller's evidence verifier to approve every ground-truth reference and every retrieved candidate. Scope mismatches, unverified results, malformed references and duplicate hits are counted as contamination and cannot be scored as relevant evidence.

The evaluator reports macro-averaged precision@k, recall@k, MRR, nDCG@k and verified-result coverage. assessSemanticShadowEligibility can label a verified evaluation SHADOW_ELIGIBLE only when operator thresholds pass. Even then, memoryWriteEnabled, productionActivationAllowed, truthPromotionAllowed and dispatch remain false.

This is an evaluation contract, not a vector database, embedding pipeline, semantic-memory store or automatic knowledge-admission mechanism. Search implementation, index rebuilds, retention/deletion, access filtering and real labelled retrieval datasets remain separate gates.

## Verification

Run: npm run lint && npm test && npm run typecheck && npm run build

The command runs runtime/core syntax checks, all Node contract tests, the existing app typecheck and the existing app production build. The WP-10 focused tests use synthetic fixtures to test deterministic behavior; they are not performance benchmarks and do not establish a production success rate, cost, throughput or scale target.

## Acceptance gates

- [x] Strict, source-verifier-bound observation schema.
- [x] Cohort-safe descriptive metrics and sample-set digest.
- [x] Bounded, operator-thresholded scale proposals; no automatic application.
- [x] Baseline/candidate descriptive comparison; no causal claim.
- [x] Source-verified, scope-bound semantic retrieval evaluation.
- [x] Shadow-only quality gate; no memory writes or truth promotion.
- [x] Focused Node tests for valid, hostile, insufficient and contaminated inputs.
- [x] Run full repository CI on the final commit SHA: GitHub Actions run 44587980697 completed successfully on Node 22; npm ci, lint, full Node test suite, typecheck and build all passed.
- [ ] Integrate verified runtime observations from the real worker/operator event source.
- [ ] Collect representative, labelled retrieval datasets and conduct independent relevance review.
- [ ] Establish cost/latency/recovery budgets from measured staging baselines before proposing real concurrency targets.
- [ ] Independent security and operational review before any execution or deployment work.

## Non-goals and safety

- No new worker process, agent count expansion, provider call or remote dispatch.
- No automatic concurrency changes, self-modification or self-authorization.
- No new vector database, embedding provider or semantic-memory writes.
- No production connection, migration, deployment, publication, secret change or main update.
- Synthetic tests and passing CI must never be represented as live staging performance evidence.
