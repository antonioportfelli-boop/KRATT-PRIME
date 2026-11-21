# Phase 10 — Runtime Observatory v1

**Repository:** `antonioportfelli-boop/KRATT-PRIME`  
**Candidate branch:** `feature/phase10-runtime-observatory-v1`  
**Hardening branch:** `feature/wave10-observatory-hardening-remediation-v1`  
**Status:** implementation candidate; staging-only, not deployed.

## Purpose

Phase 10 implements the Runtime Observatory workstream from the KRATT PRIME build roadmap. It turns real operation lifecycle events into a durable, queryable and integrity-verifiable timeline without inventing activity or collecting raw payloads.

The Observatory is a control-plane capability. AURA remains a separate visualizer; STEEL, FRAME.9 and GOLIATH remain separate products. This phase adds a protected read API and storage contract that an authorized interface can consume; it does not falsely claim that the existing AURA screen is already wired to that API.

## Architecture

1. **Typed event contract** — `packages/kratt-core/src/runtime-observatory.mjs`
   - Schema: `kratt-runtime-operation/v1`.
   - Real statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, `not_run`.
   - Capability states remain distinct: `bound`, `partial`, `mock`, `unbound`, `disabled`.
   - Only allowed lifecycle transitions are accepted. Terminal operations cannot restart.
   - Duration is computed from recorded start/finish timestamps; it is never inferred or populated with demo values.
   - IDs and evidence references are accepted; arbitrary objects, payload bodies, URLs with query strings and undeclared fields are rejected.

2. **Observed execution wrapper** — `packages/kratt-core/src/observed-operation.mjs`
   - Persists a `queued` event and a `running` event before calling the operation.
   - If those records cannot be persisted, the operation is not executed.
   - On return/throw, it records the actual terminal outcome and measured duration.
   - If the operation ran but its terminal result cannot be persisted, the wrapper returns `OUTCOME_UNRECORDED`; it does not claim success or automatically replay the operation.
   - Error text and raw request/response content are never placed in operation records.
   - An identical idempotent append is accepted as already durable; a failed queue/start append prevents execution.

3. **PostgreSQL persistence** — `packages/kratt-core/src/postgres-runtime-observatory-store.mjs`
   - `kratt_runtime_operation_events` is the append-only source of truth.
   - `kratt_runtime_observatory_head` holds a serialized sequence/hash head.
   - `kratt_runtime_operations` is a query projection of the latest event per operation.
   - Event append, projection update and hash-head advancement occur in one database transaction.
   - Event IDs are idempotent only when the canonical event is identical. Reusing an event ID with different content is rejected.
   - `verifyChain()` checks sequence continuity, previous hashes, canonical event hashes, legal state transitions and projection parity.

4. **Protected read API** — `packages/kratt-orchestrator/src/runtime-observatory-api.mjs`
   - Read endpoints: `GET /observatory/operations`, `GET /observatory/operations/{id}`, `GET /observatory/operations/{id}/events`, `GET /observatory/modules`, `GET /observatory/integrity`.
   - Every request requires an injected server-side `authorizeRead` function. Missing, false, thrown or malformed authorization results are denied.
   - The API is a library adapter, not a publicly mounted unauthenticated endpoint. A host must supply its real policy authorizer before mounting it.
   - List filters are bounded and validated before storage access; invalid client filters return HTTP 400.
   - Event history responses omit internal previous/hash-chain values.
   - Integrity responses expose pass/fail and counts, not internal hashes.

5. **Staging integration**
   - Migration `0004_runtime_observatory.sql` adds the head, append-only event table and latest-operation projection.
   - The staging server verifies that the required Phase 10 tables exist and that the observatory head is readable before startup.
   - `GET /health/ready` reports a boolean `runtimeObservatory` check without returning SQL details.
   - The actual Telegram competitive webhook ingestion is wrapped by the observed-operation runner. Each delivery attempt gets a unique operation ID and stable update correlation; only opaque references and lifecycle metadata are persisted.
   - The existing staging migration runner now applies migrations 0002, 0003 and 0004 in order, only after explicit staging opt-in and database-name confirmation.
   - `scripts/wave10-verify-runtime-observatory.mjs` runs a read-only full-chain and projection consistency check.

## Data contract

Each operation event contains:
- operation ID and correlation ID;
- module, adapter and capability IDs;
- the truthful capability state;
- status and exact event timestamp;
- start/finish timestamps and measured duration, when applicable;
- opaque input/output references;
- typed evidence references to logs, tests, artifacts, commits or traces;
- runtime environment and runtime version.

The store does not persist secrets, user prompts, raw source data, HTTP headers, full exception messages, or arbitrary application objects. Resource measurements are not fabricated; host resource metrics are not included until a measured collector is explicitly connected.

## Database permissions

Use a separate migration identity to apply migration 0004. The runtime identity should receive only:
- SELECT and INSERT on `kratt_runtime_operation_events`;
- SELECT and UPDATE on the singleton `kratt_runtime_observatory_head`;
- SELECT, INSERT and UPDATE on `kratt_runtime_operations`;
- no DDL and no DELETE on the append-only event history.

The migration installs triggers that reject UPDATE and DELETE on the event history. The operation projection can be updated because it is a rebuildable latest-state view of the event source.

## Commands

Apply only to the named staging database:
```sh
WAVE10_APPLY_STAGING_MIGRATIONS=true node --env-file=.env.wave8 scripts/wave8-apply-migration.mjs
```

Check the complete observatory chain:
```sh
node --env-file=.env.wave8 scripts/wave10-verify-runtime-observatory.mjs
```

Run the complete local quality gate:
```sh
npm run wave10:verify
```

The quality gate runs Node contract tests, the existing app typecheck and build. It does not deploy, configure Telegram, or mutate a production database.

## Acceptance gates

- [ ] Lifecycle tests cover valid transitions, invalid transitions, immutable metadata, timing and terminal-state enforcement.
- [ ] Store tests cover transactional event append, duplicate-event idempotency, event-ID conflict, projection updates and hash-chain tamper detection.
- [ ] API tests prove default-deny authorization and deny non-GET actions.
- [ ] Observed runner tests prove that an unrecordable queue prevents execution and that an unrecordable terminal result is never reported as completed.
- [ ] Existing Wave 8 staging tests still pass with the Phase 10 schema gate.
- [ ] CI passes contract tests, typecheck and build.
- [ ] A supervised staging database has migration 0004 applied and the read-only integrity command returns `VERIFIED`.
- [ ] A host supplies an actual read authorizer before exposing Observatory routes to any UI.

## Explicit non-claims

A passing test suite does not prove that production adapters are connected, that real operation events have been emitted, or that a UI is consuming them. No production deployment, production migration, external webhook write, secret rotation, provider dispatch or main-branch update is part of Phase 10.

## Wave 10.1 hardening addendum

- Idempotent duplicate event acknowledgements no longer fail the observed-operation runner; event ID content conflicts remain rejected.
- Startup and readiness verify the complete event hash chain, legal transitions and projection parity.
- Event history API supports bounded descending cursor pagination.
- Successful operation events require a non-null opaque output reference.
- Malformed previous status values are rejected.
- Integrity verification returns success only after a full chain check.
- CI runs on feature branches as well as main.
