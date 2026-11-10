# KRATT PRIME Production Readiness Gates V1

**Status:** production-readiness plan; all gates below remain closed until their evidence is attached.  
**Current implementation branch:** `feature/kratt-telegram-control-plane-v1`  
**Current PR:** #25, draft, base `feature/kratt-prime-50k-productization-v1`  
**Latest verified code head:** `ccdd6cef62b98fd8f304dfd7a2af690881005154`

This document separates implementation evidence from permission to operate a production system. Passing unit tests and building the web console do not authorize a production deployment.

## Current verified evidence

- 149 Node.js tests passed, 0 failed on the latest verified head.
- CI syntax checks, TypeScript typecheck and Vite build passed.
- `npm audit --audit-level=high` reports 0 vulnerabilities.
- Dependency lock remediation: `source-map-js 1.2.2`, `vite 8.3.7`.
- Root CAS, ontology validator, deterministic reflection reducer, typed-memory journal, backup verification and restore have synthetic/local tests.
- Telegram transport is not mounted on a public listener; no live bot credentials or production root are configured.

## P0 — required before any production data or external connection

### 1. Canonical ontology and policy sign-off
- [ ] Ontology owner approves `kratt-ontology/v1` node types, exact fields, typed relations and versioning policy.
- [ ] Define relation-level and path-level authorization, including allowed state transitions.
- [ ] Confirm claim/evidence source-reference semantics and time-scope rules against canonical KRATT domain records.
- [ ] Approve explicit migration and compatibility policy for existing roots.
- Evidence: signed architecture decision, schema fixtures, negative/positive policy tests.

### 2. Production persistence
- [ ] Replace the single-host reference SQLite root and typed-memory adapters with a supported shared serializable database for multi-instance deployment.
- [ ] Select and pin the supported database engine and driver; verify transaction isolation and uniqueness constraints.
- [ ] Add forward-only migrations, schema compatibility checks and rollback/roll-forward plan.
- [ ] Exercise simultaneous writers from independent processes, lock contention, process crash during CAS, retry and recovery.
- [ ] Prove backup encryption, off-host storage, retention, restore integrity, RPO and RTO.
- Evidence: integration test report against the selected database, migration history, concurrency/load report and restore drill.

**Known risk:** current reference adapters use Node 22 `node:sqlite`, which is experimental, and are single-host only. They are not the selected production persistence architecture.

### 3. Identity, signing and secrets
- [ ] Provision an architect public-key ring through the production secret/configuration manager.
- [ ] Select an external or hardware-backed signer and document custody, access, revocation, rotation and recovery.
- [ ] Configure Telegram bot token and webhook secret in a secret manager; never store them in Git or ordinary logs.
- [ ] Confirm the architect actor allowlist and private-chat binding from an authoritative identity source.
- [ ] Verify trusted time synchronization and fail-closed clock behavior.
- Evidence: redacted configuration attestation, key ceremony record, signer integration tests and secret-scanning results.

### 4. Security and independent review
- [ ] Independent reviewer completes code review and resolves all P0/P1 findings.
- [ ] Run SAST, dependency audit, secret scan, license review and threat-model review on the exact release commit.
- [ ] Configure protected release branches, required checks and mandatory review; current feature branch is unprotected.
- [ ] Verify least-privilege runtime identity, trusted proxy boundaries, ingress rate limits, request size limits and network egress policy.
- [ ] Validate log redaction, audit retention, alerting and incident response.
- Evidence: signed review, scan reports, branch-protection settings, threat model and operational runbook.

## P1 — staging readiness

### 5. Production adapters and service wiring
- [ ] Wire the canonical claim/evidence repository into the read-only projection and reflection reducer.
- [ ] Wire source capture, RSS/URL import and source rights/retention policy.
- [ ] Configure Telegram webhook transport only in isolated staging; validate secret header, replay, rate limits, duplicate delivery and outage recovery.
- [ ] Keep all content untrusted; prohibit instructions in external messages from triggering tools or writes.
- [ ] Confirm widget callbacks create intent only and signed approval is required for every mutation.
- Evidence: staging end-to-end run with synthetic or approved public data, no real production root.

### 6. Observability and operational controls
- [ ] Correlation IDs and trace IDs span ingress → source → claim → evidence → review → proposal → CAS.
- [ ] Metrics: intake volume, rejection rate, duplicate rate, evidence integrity failures, contradiction backlog, approval latency, CAS stale/conflict/error rates.
- [ ] Alerts: invalid signature, audit-chain failure, repeated stale writes, unexpected ingress spikes, DB saturation and failed backups.
- [ ] Define kill switch, incident containment, restore, and data deletion/retention workflows.
- Evidence: dashboards, alert tests, on-call runbook and incident simulation.

## P2 — controlled production rollout

### 7. Go-live sequence
1. Release a signed immutable build to staging.
2. Run migration and restore drills against production-like data.
3. Enable read-only source intake with strict allowlists and quotas.
4. Compare reducer outputs with human-reviewed outcomes; measure false contradiction and missed contradiction rates.
5. Enable review UI without root writes.
6. Run a limited canary with architect approval and an isolated root.
7. Enable narrowly scoped root CAS only after the preceding evidence is accepted.
8. Expand traffic gradually with rollback/kill-switch verification at every step.

### 8. Go/no-go criteria
Production may be considered only when all P0 items are complete, P1 staging evidence is accepted, and the release owner explicitly approves the go-live change.

Immediate **NO-GO** conditions:
- unapproved ontology or migration;
- unresolved high/critical dependency or security finding;
- invalid or unavailable signer, clock, audit chain or evidence provenance;
- shared database isolation/concurrency not demonstrated;
- backup restore not demonstrated;
- any automatic model claim promotion;
- live Telegram write path without request-bound approval;
- missing rollback, kill switch, monitoring or incident owner.

## Current disposition

**NO-GO for production deployment.** The feature branch has strong local/CI evidence, but the shared production database, trusted signer provisioning, canonical claim/evidence adapters, independent review, protected release controls, staging exercise and operational recovery evidence are not yet complete.

No production deployment, live Telegram connection, production root seed/mutation, or main-branch write is authorized by this document.
