# KRATT PRIME — Master Development Roadmap v3.0
Date: 2026-11-06  
Status: GOVERNED PLAN — implementation and runtime verification are not implied.

## Mission
Build KRATT PRIME as a governed, recoverable control plane for memory, policy evaluation, agent orchestration and external adapters. Preserve the existing AURA application and independently maintained 3XTRINITY components. A repository named KRATT-PRIME is not, by itself, proof that its root application is KRATT PRIME.

## Verified baseline
- Repository: antonioportfelli-boop/KRATT-PRIME; default branch: main.
- Root README identifies the application as the AURA visualizer; package.json names it trinitywayve-aura.
- Existing workstreams include Core, WP-01 authorization hardening, trusted-clock remediation, Telegram adapter and source reconciliation.
- GitHub Actions runs have been blocked before job execution by an account billing restriction. A blocked run is not a code failure and does not prove tests passed.
- No production key material, deployment, external write execution or merge is authorized by this plan.

## Architecture principles
1. Establish source-of-truth before code changes.
2. Keep AURA, KRATT Core, STEEL, FRAME.9, CERBERUS, GOLIATH OS and Trinity Edge boundaries explicit.
3. Default-deny for missing, stale, ambiguous or unverifiable trust inputs.
4. Keep policy decisions deterministic and side effects behind adapters.
5. Persist audit and idempotency state before claiming durable execution.
6. Every feature has acceptance tests, rollback instructions and evidence.
7. Use small branches and reviewable PRs; never force-update shared branches.
8. Distinguish DESIGNED, IMPLEMENTED, TESTED, VERIFIED, INTEGRATED and PRODUCTION READY.

## Work packages
### WP-02 — Source reconciliation (P0)
Inventory repositories, branches, manifests, entrypoints and ownership. Identify canonical KRATT Core source; compare PR #2, #4, #5 and #6 ancestry and file changes. Gate: every runtime package has an identified authoritative source.

### WP-03 — CI recovery and baseline (P0)
Resolve the GitHub account billing restriction outside the repository. Run install, Core tests, typecheck, build and security checks on a functioning runner. Save run IDs, commit SHA, environment and logs. Gate: required checks execute on the candidate commit and failures are classified from actual logs.

### WP-04 — Authorization completion (P0/P1)
Reconcile trusted-clock fail-closed behavior into the current WP-01 line. Complete principal/parent/child/connector/task/resource scope intersection. Canonicalize branch/path targets and reject traversal and ambiguous encoding. Enforce evidence provenance, request-bound approvals, expiry, revocation and durable replay prevention. Check cancellation and kill switch immediately before side effects.

### WP-05 — Persistent memory and audit (P1)
Define typed records, provenance, retention, deletion and conflict semantics. Implement append-only event history, integrity checks and durable transactional writes. Add backup, restore and schema migration tests. Keep semantic/vector retrieval optional and subordinate to source-backed records.

### WP-06 — Agent runtime (P1)
Implement registry, lifecycle, task queue, leases, cancellation and bounded retries. Intersect all inherited scopes; child agents cannot expand parent authority. Add budget, concurrency, timeout and kill-switch controls. Start small; scale only after measured reliability.

### WP-07 — Telegram adapter (P2)
Keep webhook validation, canonical task envelope, policy decision, inbox claim, execution and audit distinct. Add PostgreSQL concurrency tests, transactional outbox, worker recovery and real webhook contract tests. Keep Bot API writes and payments disabled until explicit production approval.

### WP-08 — Plugin gateway (P2)
Define typed capability manifests and per-tool scopes. Validate inputs/outputs, deadlines, quotas, provenance and idempotency. Require policy authorization before side effects.

### WP-09 — Platform integration (P3)
FRAME.9: shared schemas/contracts. AURA: visualizer/UI surface. STEEL: compact local-first runtime. CERBERUS: Android adapter and permission boundary. GOLIATH OS: orchestration integration. Trinity Edge/EdgeFlow: mobile control panel. Each integration has versioned contracts and compatibility tests.

### WP-10 — Scale and optimization (P4)
Expand agent factories gradually, measuring task success, cost, latency and recovery. Add semantic memory only with provenance and retrieval evaluation. Run performance baselines before claiming improvements.

## 30-day sequence
- Days 1–3: source inventory and PR reconciliation.
- Days 4–7: restore CI and capture baseline.
- Days 8–11: authorization and trusted-time integration.
- Days 12–15: persistent memory and audit.
- Days 16–19: agent runtime and scope enforcement.
- Days 20–23: Telegram adapter recovery and integration.
- Days 24–26: plugin gateway contracts.
- Days 27–30: platform integration review and acceptance report.

Dates are planning targets, not guarantees; CI billing, repository access and source discovery are external dependencies.

## Release gates
No merge to main, production deployment, public release, key provisioning, account/role change or live external write is authorized by this roadmap. Each requires a separately reviewed change and explicit approval.