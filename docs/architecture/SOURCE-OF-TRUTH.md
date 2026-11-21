# Source of Truth and Repository Boundaries
Date: 2026-11-06  
Status: VERIFIED REPOSITORY METADATA + OPEN SOURCE IDENTIFICATION

## Verified facts
- Repository: antonioportfelli-boop/KRATT-PRIME; default branch: main.
- Root README identifies the application as the AURA visualizer.
- Root package.json declares package name trinitywayve-aura.
- Package scripts include Vite build, TypeScript typecheck and a Node test command targeting packages/kratt-core/test/*.test.mjs.
- These facts establish a mixed repository surface; they do not establish that the root application is KRATT PRIME.

## Rules
1. Inspect manifest, entrypoint, source tree and tests together before assigning ownership.
2. Branch name, PR title or directory name is not proof of canonical ownership.
3. Preserve existing AURA files unless an explicit migration is reviewed.
4. KRATT Core is canonical only after package boundary, exports, test ownership and runtime composition root are verified.
5. AURA, STEEL, FRAME.9, CERBERUS, GOLIATH OS and Trinity Edge remain separate products/modules with versioned contracts.
6. For divergent branches, compare ancestry and per-file patches; do not merge by title or recency.

## Open questions
- Is packages/kratt-core the authoritative Core package on the current WP-01 branch?
- Which branch is the current integration candidate for WP-01?
- Can PR #6 trusted-clock changes be reconciled with PR #2 without losing later fixes?
- Does Telegram consume the same trusted runtime contract as WP-01?
- Which repository owns the production composition root and durable adapters?

## Decision gate
Do not change root application architecture or move files until inventory and dependency graph are reviewed.