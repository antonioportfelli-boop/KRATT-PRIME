# KRATT PRIME — Wave 1–10 deep audit and next build plan

**Audit date:** 2026-11-21  
**Repository:** antonioportfelli-boop/KRATT-PRIME  
**Main baseline observed:** ef3422809bbc54381a9ca3a15904727074ca0b16  
**Audit scope:** Waves 1–10, PRs #27–#42, progression/control-desk work, Observatory HTTP integration, trusted evidence gating and release blockers.

## 1. Executive finding

KRATT PRIME has meaningful implementation across the ten waves, but it is not yet one verified cumulative release line. The key issue is branch lineage and evidence maturity, not a lack of features.

The repository's GitHub state shows:

- PR #39 was merged into the Phase 10 candidate branch, producing candidate head de5e3f084464f8051f34544b5314bb22bc2a235a.
- PR #40 was merged into the Wave 10 hardening branch, producing merge commit bdda0df167d529ddbb583afbbfde39482ab91f5d.
- PR #38 remains open and unmerged on the Wave 10 hardening branch.
- PR #41 remains an open draft based on bdda0df. It adds the Observatory HTTP adapter/server mount and STEEL protocol hardening.
- PR #42 remains an open draft based on the Wave 1–10 progression branch. Its head descends from the merged Wave 10 integration tree and adds trusted evidence gates.
- The two continuations #41 and #42 must be reconciled into one canonical next branch before their overlapping Wave registry/evidence changes are promoted.

The current main SHA remains ef3422809bbc54381a9ca3a15904727074ca0b16. None of these operations changed main.

## 2. Verification evidence and its limits

### PR #41 — Observatory HTTP + STEEL trust hardening

Head: ddcab695e3cdc5e4d41709d7975e796fc81938a1  
Base: bdda0df167d529ddbb583afbbfde39482ab91f5d  
State: open draft  
Actions run: 44820656006 — success

Verified on that exact head:
- Wave progression tests: 11/11
- Complete KRATT Core + Orchestrator tests: 190/190
- Typecheck: pass
- Application build: pass

The branch adds a protected HTTP adapter, same-origin server mounting, default-deny handling for anonymous reads, bounded principal snapshotting, duplicate query rejection, and stricter STEEL task/receipt snapshot validation. It also pins inspected STEEL protocol source blobs.

What this does not prove:
- the actual host has injected an authenticated principal resolver and read authorizer;
- the real STEEL repository has not changed since the pinned source snapshot;
- any external credential, staging database, webhook or provider is live.

### PR #42 — trusted Wave evidence gates

Earlier head: 70f5140f2957561e9d7dbb5b754cbf2abb57c992  
Current audited head after additional hardening: b9e2d785ad28cbed1e4bab6a5bf34914aee5b364  
Base: feature/wave1-10-progression-alignment-2026-11-20  
State: open draft

Actions run 44823623510 passed on the earlier head:
- trusted Wave/UI tests passed;
- complete contract suite: 180/180;
- typecheck and build passed.

Additional code was subsequently written to the current head:
- snapshot and validate untrusted evidence inputs without invoking getters;
- reject sparse arrays, malformed objects and proxy traps;
- discard caller-provided verified hints before calling the verifier;
- enforce bounded evidence arrays and candidate counts;
- use one shared verification deadline and abort signal for verifier calls;
- reject explicit null collections rather than treating them as omitted.

These latest changes have not yet been rerun by GitHub Actions. Do not treat the older green run as proof for the current b9e2d78 head.

## 3. Wave-by-wave status and required build

| Wave | Current code / source state | Critical next build | External proof still required |
|---|---|---|---|
| 01 — Foundation | Core contracts, registry, Saga and memory ledger exist on main | Contract version policy, compatibility matrix, migration owner and consumer contract tests | Full list of downstream consumers |
| 02 — Trust | Authorization hardening candidates exist; trusted Wave gate is now fail-closed by injected verifier | Real evidence-record service, signing/verification implementation, key rotation/revocation, expiry and replay state | KMS/HSM, named key owners, security sign-off |
| 03 — Fabric | PR #27 Fabric gateway and PR #28 authorized dispatch are sibling drafts against main | Select one canonical event envelope; define tenant/resource scope, dedupe key and read/write lifecycle; reconcile dispatch/audit interfaces | STEEL contract approval and provider identity |
| 04 — Durability | PR #30 PostgreSQL outbox candidate is still based on main | Prove nonce, cancellation, idempotency, intent, outbox and audit share the required atomic boundary; add concurrency/failover tests | Real PostgreSQL integration and privilege verification |
| 05 — Async + STEEL | PR #31 async trusted runtime; PR #41 hardens the STEEL adapter | Integrate the adapter against the canonical upstream schema and independently verify ActionReceipts; cancellation and timeout propagation | Current STEEL repository source and integration runner access |
| 06 — Intelligence | PR #32 parser, competitive intelligence and TCO logic | Source reliability model, temporal comparability, currency/unit normalization, confidence/coverage and deterministic signed reports | Licensed data feeds, permission to process and provenance of actual source observations |
| 07 — Telegram | PR #33 ingestion, durable inbox, replay control and immutable snapshots | Retention/deletion policy, channel-owner consent, poison-message handling, audit redaction and replay/flood tests | Bot identity, webhook/DNS/TLS and channel authorization |
| 08 — Staging | PRs #34 and #35 are sibling candidates against main | Merge/reconcile config, parser, migrations and server composition; add rollback and dry-run migration checks | Staging DB, secret manager, network policy, DNS and TLS |
| 09 — Resilience | Wave 9 code is represented in the Phase 10 candidate and separate branch | Crash-recovery tests, migration lock/fencing, backup/restore, multi-replica chaos and SLOs | Multi-node staging and a witnessed restore exercise |
| 10 — Observatory | PR #36 candidate, PR #39 merged into its branch, PR #38 remains open; PR #41 adds HTTP mount | Finish principal resolver and authorizer integration, instrument all important modules, validate pagination/rate limits and retention | Real auth provider, database roles, staging integrity attestation |

## 4. Critical architecture gaps across all waves

### P0 — Trust root and release authority

1. Implement a server-owned evidence registry. A reference must resolve to an immutable record with digest, issuer, subject, repository, commit, wave, evidence kind, timestamp and retention metadata.
2. Implement the cryptographic verifier behind the injected gate callback. Validate algorithm allowlist, signing key status, signature, audience, tenant/resource scope, issue/expiry time, revocation and nonce/replay.
3. Bind evidence to the exact release target: repository, branch, commit SHA and environment. Do not allow a test result from a different branch or commit to satisfy the current release gate.
4. Store signed Wave completion attestations independently of the client. A completedWaveIds array or local UI state is not an attestation.
5. Ensure a verifier timeout, DB outage, revocation lookup failure or audit append failure denies promotion.

### P0 — Canonical integration lineage

6. Build one cumulative integration line. Reconcile #27/#28 first, then #30, #31–#33, #34/#35, and finally #36/#38/#41/#42. Preserve sibling candidates and review their diffs; do not merge two stacks solely because Git reports them mergeable.
7. Define one canonical 3XT Fabric event envelope and one Integration Registry state machine. Keep READ and WRITE permissions separate, and bind every write to principal, operation, resource, argument digest, approval ID and expiry.
8. Establish tenant/resource scope consistently in task, event, evidence, outbox, snapshot, operation, report and audit contracts.

### P1 — Durable execution safety

9. Prove that cancellation and dispatch serialize on the same durable task/operation state. A late worker must not dispatch after a successful cancellation.
10. Test worker lease fencing, expired lease recovery, duplicate delivery, retry exhaustion, dead-letter replay and audit-chain consistency using concurrent database sessions.
11. Add migration checksums, advisory migration locks, forward-recovery plans and a tested restore procedure.
12. Distinguish “accepted”, “queued”, “executed”, “provider-confirmed” and “audited”. Do not collapse them into one success flag.

### P1 — Data and connector integrity

13. Make every competitive claim traceable to a source record, capture time, region, unit, currency, observation window, confidence and immutable digest.
14. Add data rights, consent, retention and deletion controls for Telegram and model processing. Raw message bodies must not enter operational logs or Observatory events.
15. Add provider-specific timeout, rate-limit, idempotency, retry and capability-state contracts. A configured API key does not prove an adapter is usable.
16. Verify STEEL protocol pins against the current canonical upstream repository on every protocol update. Do not maintain a forked schema.

### P1 — Observatory and UI truthfulness

17. Inject a real server-side principal resolver and authorization policy. Keep anonymous reads denied by default.
18. Apply per-principal rate limits and bounded pagination to all read endpoints, especially operation-event history.
19. Instrument agent dispatch, model calls, integrations, ingestion, database jobs and reports through the same observed-operation wrapper.
20. Separate expected capability from actual capability. UI states must explicitly distinguish bound, partial, mock, unbound, disabled, denied and degraded.
21. Add browser tests for 360px mobile, tablet and desktop; keyboard-only navigation; reduced motion; 401/403/404/503; loading, empty, stale and integrity-failure states.

### P2 — Product and operations

22. Define operational SLOs for ingestion delay, queue age, worker recovery, operation completion, evidence verification latency and Observatory freshness.
23. Add a versioned incident runbook, alert routing, backup retention and incident evidence export.
24. Add reproducible staging promotion evidence and a release manifest containing source SHA, migration checksums, test run IDs, SBOM/dependency audit and operator approvals.
25. Complete the commercial product boundary: tenant plans, report entitlements, usage metering, customer data isolation, export permissions and auditable billing records. These are not yet proven by the Wave 1–10 runtime contracts.

## 5. What can be built immediately in repository code

These are repository-local tasks and do not require production secrets:

1. Harden evidence and completion input parsing, immutable snapshots, bounded verifier execution and negative-path tests.
2. Add a signed evidence envelope schema and a verifier interface with a test-only keyring implementation.
3. Add release-target binding to repository/branch/commit/environment.
4. Add a per-wave completion attestation contract and append-only evidence/audit record interfaces.
5. Add tenant/resource scope fields to Fabric, dispatch, operation, evidence and snapshot contracts, with compatibility tests.
6. Add an Integration Registry conformance suite and canonical event envelope schema.
7. Add an explicit cancellation/dispatch race test matrix for SQLite and PostgreSQL stores.
8. Add migration checksum/lock/forward-recovery code and a dry-run report.
9. Add adapter contract tests for Telegram, OpenAI and STEEL, including negative tests for missing credentials and invalid scope.
10. Add rate-limited, cursor-bounded Observatory reads and API contract tests.
11. Add operation instrumentation wrappers around every real module boundary.
12. Add Control Desk browser/E2E tests and capability-state visual regression checks.
13. Add release manifest, SBOM, dependency audit and evidence-export schemas.

## 6. What cannot be honestly marked complete through repository writes

The following require operator access or external decisions:

- KMS/HSM provisioning, signing key ownership and revocation authority;
- real staging PostgreSQL, least-privilege grants, multi-replica failover and backup restore;
- Telegram bot token, webhook DNS/TLS, channel allowlists and content consent;
- model-provider credentials, quota and data-processing approval;
- licensed competitive data feeds and source-use rights;
- production identity provider, tenant mapping and authorization policy;
- operator sign-off for staging promotion.

Code can prepare these integrations and test their fail-closed behavior. It cannot truthfully claim that external resources are connected or approved when they have not been verified.

## 7. Recommended build order

**Next Wave 1–10 continuation:**

- **P0.1 — Evidence Trust Root:** immutable evidence records, signed envelope, verifier contract, key status/revocation, expiry and replay.
- **P0.2 — Release Target Binding:** repository/branch/commit/environment binding, dependency completion attestations and signed release manifest.
- **P0.3 — Canonical Integration Line:** reconcile PR #27/#28 and #30–#35 into a reviewable cumulative chain without changing main.
- **P1.1 — Execution Safety:** cancellation/dispatch serialization, worker lease fencing, retry/dead-letter and real PostgreSQL concurrency suite.
- **P1.2 — STEEL + Connector Conformance:** current upstream protocol pin, receipt verifier, adapter compatibility and capability-state reporting.
- **P1.3 — Evidence Intelligence:** provenance, temporal pricing comparability, data-use controls and reproducible signed reports.
- **P1.4 — Observatory Coverage:** principal/authorization injection, rate limits, pagination and instrumentation across modules.
- **P2.1 — Control Desk Verification:** browser E2E, visual regression, accessibility and stale/offline/integrity states.
- **P2.2 — Release Operations:** staging checklist, SLOs, restore exercise, SBOM, audit export and operator attestation.

## 8. Promotion rule

A wave is not complete because a branch exists, its PR is mergeable, a mock test passes or a UI card looks connected. Promotion requires:

- dependencies independently attested;
- tests on the exact candidate SHA;
- security and contract review;
- typecheck/build where applicable;
- evidence verified against the target repository and commit;
- staging evidence where the wave introduces external runtime behavior;
- an auditable release decision.

Until then, the system must show the capability as partial, unbound, mock, denied or staging-unverified rather than silently upgrading its state.
