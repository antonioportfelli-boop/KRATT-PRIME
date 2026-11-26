# 3XTRINITY Platform Source of Truth — v1

**Review date:** 2026-11-26  
**Status:** audited repository map and build baseline  
**Scope:** connected GitHub visibility and public repository evidence; not a complete audit of every private organization repository or deployment environment.

## Purpose

This document separates canonical repositories, copies, application entrypoints and development branches. The machine-readable companion is packages/kratt-core/src/platform-portfolio.mjs. Its test file is included by the existing KRATT core test glob.

## Canonical ownership

| System | Canonical repository | Default branch | Responsibility | Maturity |
|---|---|---|---|---|
| KRATT PRIME | antonioportfelli-boop/KRATT-PRIME | main | Governed orchestration, policy, evidence, semantic integrity and execution runtime | Core |
| STEEL | 3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP- | main | Application shell, workspace, Factory dispatcher, protocol, audit and security | Active application |
| FRAME.9 | antonioportfelli-boop/FRAME.9 | main | Signal desk, modular workspace, network and host-awareness interfaces | Active application; development on Forge.-9 |
| AURA | 3XTRINITY-CORPORATION-AND-SOFTWARE/AURA-3XTRINITY-CORPORATION-SOFTWARE-OFFICIAL-visualizer-programm | main | Visualizer and visual-presence experience | Prototype |
| GOLIATH | packages/goliath-kernel inside KRATT PRIME | KRATT main | Experimental Rust/XDP/eBPF telemetry slice | Experimental component, not a separate repository |

The Antonio-account STEEL copy observed during review was empty. The organization FRAME.9 copy was also empty. Do not develop against those copies without a deliberate repository transfer decision.

## KRATT PRIME repository identity mismatch

The canonical KRATT repository contains real implementation layers:

- packages/kratt-core: policy, contracts, authorization, evidence and capability primitives.
- packages/kratt-runtime: governed execution, durable evidence and worker leases.
- packages/kratt-orchestrator: orchestration, local server and RSS read adapter.
- packages/goliath-kernel: experimental Rust and XDP/eBPF source.
- products/kratt-prime-console: a separate console UI.

However, the root README, package name and src/App.tsx still identify/render the AURA visualizer. The KRATT PRIME console exists separately under products/kratt-prime-console. This is a product entrypoint/documentation mismatch, not evidence that the KRATT backend is absent.

**Required correction:** decide and document the canonical KRATT application entrypoint, then align README, package metadata, scripts and build output. Preserve AURA as a distinct product; do not silently replace or merge either app.

## Maturity rules

- **Core:** tested source primitives exist in the canonical repository. This is not a production deployment claim.
- **Active application:** editable application and meaningful test/build structure exist. Current CI must still be checked before release.
- **Prototype:** user-facing behavior exists, but live device/provider/cross-system behavior is not established.
- **Experimental:** research or platform-specific source exists with known limits; do not represent it as a supported production capability.

Maturity is not a valuation, uptime commitment, security certification, release status or customer-readiness statement.

## Evidence and review limits

Repository metadata, source trees, package scripts, branch refs, pull requests and workflow runs were inspected on 2026-11-26. Key evidence:

- KRATT main at 782373cd7760a12141c75655dd890313c30f3021; CI run 45720192115 passed core/orchestration tests, syntax checks, typecheck and build.
- STEEL main at 1da5fd84d9ebb0a796326e3453d052ca73bc7650; latest observed full Vite CI success on main was run 43120764111 on 2026-11-11. Later scheduled security/deception workflows passed but do not replace a fresh full CI run.
- FRAME.9 documents Forge.-9 as the development branch and main as its stable base. An inspected Dependabot run on Forge.-9 failed on 2026-11-23.
- AURA describes its spectrum modes as simulated and OS/Android surfaces as planned.
- GOLIATH documents a user-space analysis library and XDP/eBPF source specimen, parser limits and no automatic privileged attachment.

The connected Antonio account exposed 26 repositories. Public 3XTRINITY organization search returned four repositories. This does not prove that all private organization repositories were visible or audited.

## Non-negotiable source-of-truth rules

1. One canonical repository per system; forks and personal copies are labelled.
2. main is the stable source unless the system's documented policy says otherwise.
3. Development work uses feature branches and reviewed pull requests.
4. A branch existing is not proof that its changes are merged, tested or deployed.
5. Passing unit tests is not proof of external integration or production readiness.
6. Cross-system writes remain denied until trusted, request-bound approval and the existing authorization/dispatch boundary are verified.
7. No deployment, production write, secret rotation or main-branch mutation is implied by this portfolio.

## Next source-of-truth actions

1. Resolve the KRATT/AURA app-root identity mismatch without deleting either product.
2. Reconcile KRATT construction, reflection, execution-ledger and WP-01 branches into one reviewed dependency chain.
3. Confirm the STEEL Fabric v1 branch against current main, run CI, then decide whether to open/refresh a draft PR.
4. Verify FRAME.9's Forge.-9 health and KRATT adapter/topology contract before claiming integration.
5. Establish a live AURA-to-STEEL visualizer contract before describing synchronization as implemented.
6. Validate GOLIATH on a dedicated Linux test host before privileged attachment work.