# 3XTRINITY Platform Integration Build Roadmap — v1

**Baseline:** 2026-11-26  
**Status:** first governance/build tranche  
**Execution policy:** feature branches and draft PRs only; no production deployment or main mutation.

## Objective

Turn KRATT PRIME, STEEL, FRAME.9, AURA and GOLIATH from separately documented systems into a testable platform with explicit ownership, stable contracts, evidence-backed integration state and a controlled release path.

## Current integration register

| Edge | Existing evidence | Readiness | Not yet proven |
|---|---|---|---|
| KRATT PRIME → STEEL | STEEL feature/3xt-fabric-v1-event-contract contains Fabric v1 contract, tests and migration; KRATT has authorized dispatch and evidence policy | Contract in progress | Verified live transport, cross-system replay handling, durable receipt chain and end-to-end tests |
| KRATT PRIME → FRAME.9 | Related topology/build contract branches exist; FRAME.9 is a separate signal workspace | Documented only | Merged adapter, authenticated event exchange, tenant/path isolation and live integration tests |
| STEEL → AURA | AURA describes intended synchronization and has a browser visualizer | Demo only | Real audio/event source, stable STEEL event contract, synchronization tests and device permission lifecycle |
| KRATT PRIME → GOLIATH | Rust user-space library and XDP/eBPF specimen live inside KRATT | Experimental | Linux BPF build, verifier run, parser coverage, attach/detach rollback and authorized config control plane |

A feature branch, UI card or design statement does not establish a live connector.

## Build phases

### Phase 0 — Portfolio and source-of-truth gate

- Keep one canonical repository record per product.
- Validate unique ownership, safe component paths, secret-free metadata and explicit integration endpoints.
- Resolve KRATT root app identity: preserve AURA as a distinct product while selecting a canonical KRATT console entrypoint.
- Record stable branch, development branch, CI evidence and caveats.

**Exit:** portfolio validation passes; no duplicate canonical ownership or unknown integration endpoints; maturity claims have dated evidence.

### Phase 1 — Branch and merge reconciliation

- KRATT: reconcile WP-01 approval evidence, construction protocol, reflection/recovery journal, execution ledger/orchestrator, durable evidence projection and fenced worker leases. Resolve diverged branches before proposing a merge.
- KRATT: inspect open capability-registry and SIPA-11 PRs for overlapping policy.mjs, contracts.mjs and core.test.mjs changes.
- STEEL: compare Fabric v1 and dual-AI branches with main, refresh against current base and run full CI on feature branches.
- FRAME.9: run the full check chain on Forge.-9; distinguish source PRs from historical merged factory PRs.

**Exit:** each retained PR has one intended base, dependency order, conflict review, CI evidence and a stated merge decision. No force push or merge is implied.

### Phase 2 — Shared contract and event transport

- Freeze the Fabric v1 envelope: schema version, producer/consumer identity, correlation ID, idempotency key, timestamps, payload digest and provenance.
- Add common compatibility fixtures in KRATT and STEEL.
- Define retry, duplicate, out-of-order, poison-message, dead-letter and replay behavior.
- Keep cross-repository writes disabled; verify read-only event exchange first.

**Exit:** schema compatibility, replay and duplicate tests pass in both repositories; event evidence is persisted and traceable.

### Phase 3 — Real provider and data-source integrations

- Start with read-only RSS/Atom and approved Telegram ingestion with immutable source snapshots and provenance.
- Add OpenAI and xAI adapters behind one typed contract with timeout, cancellation, rate-limit handling, normalized errors and redacted logs.
- Keep credentials server-side and reference-only in manifests.
- Require human review and trusted evidence verification before external actions.

**Exit:** live staging reads are repeatable and auditable; mock data is never presented as live; negative tests prove missing credentials and bad provenance fail closed.

### Phase 4 — Product entrypoints and system experience

- Select the canonical KRATT PRIME Console entrypoint and keep AURA independently buildable.
- Link STEEL Factory and authorization views to KRATT request/evidence/receipt identifiers through versioned contracts.
- Link FRAME.9 signals to KRATT evidence as read-only until its adapter is verified.
- Connect AURA only to an explicitly defined STEEL visualization event/audio interface.

**Exit:** UI distinguishes live, staging, simulated and unavailable; displayed items trace to source evidence.

### Phase 5 — Reliability, security and operational readiness

- Run typecheck, lint, unit, integration, browser smoke, build and security scans on current commits.
- Add cross-repository contract tests and reproducible staging composition.
- Exercise timeout, lost lease, duplicate event, revoked approval, stale evidence, malformed payload, provider quota and cancellation.
- Validate GOLIATH on a disposable Linux host; no production kernel operation without a separately approved plan.
- Prepare release notes, setup docs, threat model, support boundaries, backup/restore and rollback procedures.

**Exit:** release evidence bundle complete, critical tests green, security findings triaged and a human release decision recorded.

## First implementation in this tranche

- packages/kratt-core/src/platform-portfolio.mjs: immutable registry of canonical systems, components, integration edges and conservative readiness states.
- packages/kratt-core/test/platform-portfolio.test.mjs: checks portfolio structure, canonical ownership, component ownership/path safety, secret-like metadata and fail-closed integration decisions.
- docs/architecture/3XTRINITY-PLATFORM-SOURCE-OF-TRUTH-V1.md: ownership, entrypoint mismatch, evidence and caveats.
- This roadmap: phases, dependencies and explicit exit criteria.

The registry is descriptive and fail-closed. It does not connect repositories, move branches, resolve credentials, deploy or bypass KRATT's trusted authorization runtime.

## Stop conditions

Stop and request review before production deployment, external writes, credential rotation, permission/role changes, branch-protection changes, force push, merge to main, privileged XDP/eBPF attachment or irreversible data migration.