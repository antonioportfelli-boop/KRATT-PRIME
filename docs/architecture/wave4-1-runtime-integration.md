# Wave 4.1 — Runtime Integration Status

Date: 2026-11-27  
Audited revision: \`ef7f178ba4e95d44412765aeae9948f83a3450d8\`

## Executive status

Wave 4.1 integrates and hardens existing components; it does not introduce a parallel authorization or execution architecture.

Important boundaries:

- \`authorized-dispatch\` handles direct provider dispatch.
- \`governed-execution\` owns the governed worker lifecycle and execution ledger.
- \`PrimeStore\` is a local append-only hash-chained store; its lease coordinator is limited to one process / one store instance.
- PostgreSQL outbox is a separate transactional multi-consumer path.
- Operational telemetry is not the durable audit authority.

## Direct authorized-dispatch path

The verified path is:

1. Authenticate principal.
2. Validate task envelope.
3. Load trusted context and evidence.
4. Evaluate the existing policy runtime.
5. Durably append DENY/BLOCKED decisions.
6. Resolve the provider adapter.
7. Compute the existing \`canonicalTaskDigest\` and idempotency key.
8. Commit durable intent through the command store.
9. Dispatch only after the intent is committed.
10. Append provider outcome to the same command store.
11. Return COMPLETED, FAILED, or OUTCOME_UNRECORDED according to durable persistence.

The Wave 4.1 correlation change uses a validated supplied correlation ID or generates a UUID. The same value flows through trusted-context/evidence loading, authorization, durable intent/outcome, provider dispatch, and the operational telemetry event. An invalid supplied ID is rejected before provider execution; the denial is written with a safe generated audit correlation ID.

The existing \`canonicalTaskDigest\` remains the dispatch identity input. \`canonical-request.mjs\` was not substituted because semantic equivalence with the existing policy digest has not been proven. A fingerprint is not approval.

## Audit and telemetry

- \`commandStore.appendDecision\`, \`commitAuthorizedIntent\`, and \`appendOutcome\` remain the authoritative durable records.
- Telemetry is bounded, allow-listed, and non-authoritative.
- Synchronous sink exceptions and asynchronous rejections are isolated and counted.
- Ring and sink queue overflow are bounded and visible through health counters.
- A synchronous sink can still block the event loop; CPU-heavy/blocking sinks must hand off to a Worker or process.
- Dropped telemetry events do not remove durable denial, intent, or outcome records.

The event registry includes auth allow/deny/block, dispatch intent/completed/failed/cancelled, queue rejection, lease fencing, and evidence verification failure. The direct dispatch path emits the auth/dispatch events it observes. Governed-runtime cancellation, queue, lease, and evidence-verifier paths still need telemetry calls at their owning boundaries.

## Governed execution and cancellation

The existing ledger states are \`QUEUED\`, \`CLAIMED\`, \`RUNNING\`, \`RETRY_WAIT\`, \`SUCCEEDED\`, \`FAILED\`, and \`CANCELLED\`.

The runtime binds identity and task, validates evidence snapshots, authorizes, creates an execution record/receipt, acquires a worker lease, and requires a current lease for start/complete/fail/cancel operations.

Running cancellation requires worker acknowledgement. The regression investigation found the ledger transition table did not allow \`RUNNING → CANCELLED\` even when the runtime had verified acknowledgement. The transition was added; the acknowledgement guard remains.

The worker lease coordinator serializes operations associated with one \`PrimeStore\` instance and increments a fencing generation in that journal. This is not a cross-process transaction or multi-host guarantee.

## Storage boundaries

| Component | Actual role | Boundary |
|---|---|---|
| PrimeStore | local append-only hash-chained journal | one-process coordinator; no proven multi-process CAS |
| SQLite command store | durable decisions, intents, outcomes, audit | local SQLite transaction model |
| SQLite nonce store | unique nonce/approval consumption | local database uniqueness |
| PostgreSQL outbox store | transactional intent/outbox/audit | live multi-process integration remains unverified |
| Outbox worker | bounded at-least-once dispatch and retry | not exactly-once side effects |
| Execution ledger | durable governed task state | concurrency depends on storage adapter |

PostgreSQL outbox claim uses \`FOR UPDATE SKIP LOCKED\`. Expired leases are now rejected by finish/retry predicates using database time. This prevents an expired owner from writing the outbox state after its lease has elapsed, but does not create provider-enforced monotonic fencing.

## Performance scope

The current benchmark measures a real direct authorized-dispatch composition with task validation, canonicalization, policy evaluation, Ed25519 approval and evidence signatures, local SQLite command-store persistence, telemetry, audit-chain verification, and a mock provider.

It does not yet measure governed worker leases, PostgreSQL outbox, queue admission/wait, cross-process coordination, cancellation/recovery, retries, external provider latency, or an end-to-end deadline. Concurrency values are in-process logical concurrency.

## Work-package status

| Package | Status |
|---|---|
| WP-04.1-A telemetry | Partial: direct authorization/dispatch integrated; runtime queue/lease/evidence events remain |
| WP-04.1-B performance | Direct authorized-dispatch E2E baseline exists; governed runtime and Postgres profiles remain |
| WP-04.1-C queue/runtime | Existing lifecycle retained; cancellation transition fixed and lease/cancel regressions added; full saturation/restart matrix remains |
| WP-04.1-D optimization | No optimization gain claimed; measure-before-change baseline only |
| WP-04.1-E storage | PostgreSQL expired-lease finish/retry guard added; live multi-process DB test and provider fencing remain |
| WP-04.1-F GOLIATH | Rust ABI checks and feature-branch CI added; BPF C is not built/attached |
| WP-04.1-G STEEL | Read-only contract audit; bridge not implemented |
| WP-04.1-H FRAME.9 | Read-only signal/collector audit; bridge not implemented |
| WP-04.1-I quality | Node 22 tests/build/security/performance and Rust unit workflow enabled |

## Next engineering gates

1. Emit telemetry from governed runtime, queue/outbox, lease, evidence verification and cancellation boundaries.
2. Test PostgreSQL transactions with two connections and at least two independent processes, including crash/restart and stale-owner completion.
3. Exercise queue saturation, retry exhaustion, dead-letter, worker restart, cancellation races, and duplicate outcomes.
4. Add a governed-execution benchmark separate from direct authorized dispatch.
5. Run longer controlled measurements before retaining any optimization.
6. Build adapters for STEEL and FRAME.9 without duplicating their validators or bypassing WP-01.
7. Add BPF C build/verifier tests on isolated Linux runners; do not attach to production interfaces.

## Verification

- [PR #68](https://github.com/antonioportfelli-boop/KRATT-PRIME/pull/68) remains open/draft.
- [Node CI 46021742863](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742863)
- [Security hardening 46021742846](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742846)
- [KRATT PRIME CI 46021742886](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742886)
- [GOLIATH Rust 46021743006](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021743006)
- [Performance 46021732365](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021732365)

No main-branch write, merge, deployment, secret/role modification, or privileged XDP attach was performed.
