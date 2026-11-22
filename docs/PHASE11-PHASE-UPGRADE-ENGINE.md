# Phase 11 — Governed Phase Upgrade Engine

## Purpose

Phase 11 adds a resource-aware, agent-driven phase upgrade pipeline to KRATT PRIME. It reuses the hardware capability contract from the hardware-aware runtime work and adds a safe proposal-to-commit lifecycle.

## Execution model

1. A caller submits a phase request, immutable source revision, repository, base ref and a feature/* target branch.
2. The engine validates an immutable hardware snapshot and proposes a CPU/GPU/NPU/HTP/ANE or explicitly allow-listed remote route.
3. A trusted policy evaluator must return an exact request-bound ALLOW decision before any agent runs.
4. A remote route is not executable until an independently verified, unexpired approval binds the run, request, provider, data scope and transfer class.
5. The selected local or cloud adapter runs six ordered agents: architect, planner, coder, tester, critic and documentarian.
6. The coder returns bounded file proposals. The engine rejects path traversal, protected paths, credential-like content, oversized payloads and invalid base blob SHAs.
7. The tester must provide positive test results with evidence references. A separately injected trusted test-evidence verifier must validate each reference against the exact run, request, source revision, target branch and patch digest. A bare `passed: true` claim is never sufficient. Missing, rejected, expired or unverifiable test evidence blocks the run before it can become READY_FOR_APPROVAL; no repository write occurs.
8. A separate approval must bind the exact run, request, repository, feature branch, source revision, patch digest and expiry. A second policy evaluation is required before the injected GitHub writer can create a commit.
9. The GitHub writer must enforce optimistic concurrency against the submitted source revision. Merge and deployment remain separate, human-controlled operations.

## Wave 10 migration compatibility

The current Wave 10 branch no longer carries `0004_runtime_observatory.sql` as an executable migration file. Phase 11 must not reintroduce or replay it.

The pure contract in `phase11-migration-contract.mjs` defines the migration order:

1. Re-run the idempotent Wave 8/9 migrations `0002` and `0003`.
2. Verify that the Wave 10 runtime-observatory tables already exist.
3. Apply only Phase 11's `0005_semantic_memory.sql`.
4. Verify both the Wave 10 observability tables and the Phase 11 semantic-memory tables.

The migration runner requires all three conditions: `APP_ENV=staging`, `WAVE11_APPLY_STAGING_MIGRATIONS=true`, and an exact `WAVE11_EXPECTED_DATABASE` match. Legacy Wave 8/9/10 opt-in flags do not authorize a Phase 11 migration. The runner fails before applying the semantic-memory migration when the Wave 10 schema prerequisite is absent.

No migration has been executed against a database by this change.

## Wave 10 runtime observability integration

`packages/kratt-core/src/phase11-wave10-integration.mjs` composes the governed Phase 11 engine with the existing Wave 10 `createObservedOperationRunner` contract.

- `propose()`, `execute()`, `commitApproved()` and optional semantic-pipeline execution each emit queued → running → terminal observability events.
- Request IDs are converted to stable, non-secret correlation IDs; operation IDs remain unique per observed execution.
- The adapter writes through the Wave 10 observability store's existing `append(event)` interface. The PostgreSQL store remains the durable event writer and hash-chain owner.
- An observability queue/start write failure prevents the wrapped Phase 11 method from executing.
- A Phase 11 result with `ok: false` is recorded as a failed observed operation; it is never reported as a successful runtime operation.
- The adapter does not introduce a second policy, approval or GitHub write path. Only `phaseEngine.commitApproved()` can reach the configured Phase 11 writer.
- If the final observability event cannot be recorded after a commit call, the adapter reports `OUTCOME_UNRECORDED` and `sideEffectMayHaveCompleted: true`. This is an explicit reconciliation condition, not a safe retry signal. Inspect the Phase 11 run and repository commit before retrying.

The bridge defaults its capability state to `partial` and environment to `development`. Composition in staging or production requires explicit environment configuration and a real, healthy observability store. This integration code does not assert that production adapters, providers, database credentials or runtime workers exist.

## Runtime adapters

The core engine does not provision infrastructure itself. A `resourceAdapters.local.runAgent` adapter can dispatch to a detected local CPU/GPU/NPU backend. A `resourceAdapters.cloud.runAgent` adapter can dispatch to a configured cloud worker. The engine does not assume that a cloud account, GPU instance, endpoint, token or network route exists.

Bigdata.com is an evidence/research source, not an execution provider. Its imported content must remain source-attributed and reviewable before it can influence accepted phase requirements.

## Required durable store contract

The injected store must implement:

- `findByIdempotencyKey(key)`
- `createRun(run)` with a uniqueness constraint on the idempotency key
- `getRun(runId)`
- `updateRun(runId, patch)` with atomic state-transition semantics
- `appendEvent(event)` using an append-only, tamper-evident event history
- `claimLease(runId, owner)` and `releaseLease(runId, owner)` for worker fencing
- optionally `watchEvents(runId)` as an async event stream for real-time observability

Do not deploy the test in-memory store as a production persistence implementation. The production adapter should use the existing KRATT PostgreSQL outbox/runtime and preserve correlation IDs, idempotency and fencing tokens.

## Agent adapter contract

`runAgent({ agent, run, computeRoute, priorResults, signal })` returns an object with a bounded summary. The CODER stage additionally returns patches; the TESTER stage returns a non-empty list of `{ name, passed: true, evidenceRef }`. Each test evidence reference is checked by the trusted test-evidence verifier against the exact patch digest and run context. The CRITIC stage returns an empty blockers list. Agents can propose code but cannot directly write repositories or change permissions.

## Statuses

PLANNED, BLOCKED_RESOURCE, WAITING_REMOTE_APPROVAL, BLOCKED_POLICY, EXECUTING, QUALITY_BLOCKED, READY_FOR_APPROVAL, COMMITTED.

A route proposal is not proof of a configured adapter, an active worker, a running model or a completed execution. Those facts are represented by separate runtime and observability events.

## Verification

Run:

```sh
node --check packages/kratt-core/src/hardware-capabilities.mjs
node --check packages/kratt-core/src/runtime-observatory.mjs
node --check packages/kratt-core/src/observed-operation.mjs
node --check packages/kratt-core/src/phase-upgrade-engine.mjs
node --check packages/kratt-core/src/phase11-wave10-integration.mjs
node --test packages/kratt-core/test/phase-upgrade-engine.test.mjs
node --test packages/kratt-core/test/phase11-wave10-integration.test.mjs
```

The focused CI workflow runs on the Phase 11 branch and pull requests targeting the Wave 10 hardening branch.

## Non-goals and safety boundary

- No writes to main or master.
- No automatic merge, release or production deployment.
- No cloud compute unless a provider adapter is configured and exact data-transfer approval is verified.
- No direct agent credentials or secrets in prompts, event payloads or generated files.
- No automatic permission, secret, webhook, database migration or infrastructure changes.
