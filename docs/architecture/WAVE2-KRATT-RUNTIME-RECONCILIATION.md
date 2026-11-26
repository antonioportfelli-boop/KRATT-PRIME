# Wave 2 — KRATT Runtime Reconciliation

**Snapshot:** 2026-11-26  
**Branch:** feature/wave2-runtime-reconciliation-2026-11-26  
**Scope:** main-branch source inventory and open-draft dependency reconciliation. No merge, rebase, cherry-pick, runtime activation or deployment.

## Result

KRATT main already contains task lifecycle, execution ledger, trusted authorization, evidence primitives and authorized dispatch/outbox. It does **not** contain a single reconciled construction runtime composition that joins all these concerns. The worker-lease and reflection/recovery pieces are not yet established on main.

This tranche adds a versioned dependency inventory and a validator. It is intentionally not a second runtime implementation. The validator makes it harder to misstate draft work as mainline capability and detects unknown/cyclic dependencies.

## Mainline inventory

| Layer | Mainline evidence | Current limitation |
|---|---|---|
| Construction task | \`construction-protocol.mjs\` | State machine only; not an executor |
| Execution ledger | \`construction-execution-ledger.mjs\` | Deterministic record and fencing checks; storage/worker lifecycle is separate |
| Trusted authorization | \`trusted-runtime.mjs\`, policy and approval evidence | Trusted composition boundary exists; it is not a full construction scheduler |
| Evidence | \`evidence-ledger.mjs\`, \`evidence-integrity.mjs\` | Local reference ledger explicitly is not durable or signed |
| Authorized dispatch | \`authorized-dispatch.mjs\`, outbox worker and PostgreSQL outbox store | Governed dispatch path exists; does not itself reconcile reflection/recovery state |

## Draft dependencies

### Durable worker leases

Candidate: \`feature/durable-worker-leases-fencing-v1\`, used as the base for the open WP-10 scale PR #37. This branch must be reviewed as a standalone dependency before dependent work is stacked or merged. Its claim/renew/expire/fencing semantics need a direct audit against the execution ledger's fencing history.

### Reflection / recovery

No dedicated reflection-recovery journal file was found in main's \`packages/kratt-core/src\` inventory. Do not claim it is shipped. The recovery design should consume immutable execution and evidence references; it must not become a second source of execution truth or bypass trusted authorization.

### Related open stacks

- PR #37 (WP-10) targets the durable-worker-leases candidate branch, not main.
- PR #38 (Wave 10 hardening) targets Phase 10 Observatory, not main.
- PR #41 (Wave 1–10 continuation) targets Wave 10 hardening, not main.
- PR #43 and #46 are separate Phase 11 candidates; #46 is described as rebuilt on the current Wave 10 branch, while #43 remains divergent.
- PR #48 is a regression fix stacked on SIPA-11; PR #49 is a separate integration capability registry draft.
- PR #57 is the platform portfolio/readiness gate and is intentionally separate from this Wave 2 branch.

The existence of these PRs is not evidence that their changes are in main. Do not combine them by name or cherry-pick based on titles alone.

## Required reconciliation sequence

1. **Pin immutable candidate heads and bases.** For each dependency, record head SHA, base SHA, ahead/behind counts, changed paths and current CI. Stop if the branch has diverged from its stated base.
2. **Audit durable lease semantics.** Verify unique lease identity, monotonic fencing, expiry, cancellation, renewal, lost-lease rejection and atomic storage behavior. Check the contract against \`construction-execution-ledger.mjs\`; do not add a parallel worker state machine.
3. **Define the runtime composition contract.** One construction task → one deterministic execution key → one current fenced claim → trusted authorization → dispatch/outbox → terminal execution result → evidence reference. Each transition must carry the same task revision/digest and correlation ID.
4. **Define recovery as reconciliation, not replay authority.** Recovery reads execution/evidence history and proposes or performs only idempotent state repair through the existing authorized boundary. Stale claims and missing evidence fail closed.
5. **Add cross-module integration tests.** Required negatives: mismatched task digest/revision, stale fence, expired claim, revoked approval, duplicate outbox key, missing terminal evidence, tampered ledger chain, cancellation race and storage unavailable.
6. **Stack one dependency at a time.** Run focused tests, full core/orchestrator tests, typecheck and build at each head. Keep PRs draft until the dependency graph and evidence are complete.

## Acceptance gate

Wave 2 is complete only when:
- the candidate chain has one explicit base and no unresolved divergence;
- runtime composition is implemented once, not duplicated across PRs;
- authorization remains request-bound and independently verified;
- lease fencing and cancellation are enforced at the storage boundary;
- recovery cannot dispatch or promote evidence on its own;
- cross-module tests and full CI pass on the exact reviewed head;
- main remains unchanged until human review and explicit merge approval.

## Artifacts in this tranche

- \`packages/kratt-core/src/runtime-reconciliation.mjs\`: immutable inventory and dependency graph validator.
- \`packages/kratt-core/test/runtime-reconciliation.test.mjs\`: graph validity, honest maturity labels and invalid graph regression tests.
- This document: evidence-backed branch map and implementation sequence.

This tranche does not claim to have merged or implemented durable worker leases or reflection recovery.