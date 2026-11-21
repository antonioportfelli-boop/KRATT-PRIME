# Repository Source-of-Truth Audit — 2026-11-07

## Executive finding

The repository's default branch and the active KRATT PRIME runtime line do not currently present the same product/source tree. Do not merge, rebase, or transplant runtime files until the repository owner confirms the intended canonical integration target.

## Observed facts

| Item | Observation |
|---|---|
| Repository | antonioportfelli-boop/KRATT-PRIME |
| Default branch | main |
| Main SHA observed | 55a849ea11370dbd3b4ee1c688306dfb095f843e |
| Main README | Identifies the project as “AURA — 3XTRINITY CORPORATION visualizer” |
| Main package manifest | package.json describes trinitywayve-aura, Vite/React, and root-level AURA scripts |
| KRATT runtime source on main | The inspected paths packages/kratt-core/src/hardware-capabilities.mjs, packages/kratt-core/src/linux-operations.mjs, and src/lib/kratt/schema/policy.ts were not found on main |
| Runtime source on feature line | packages/kratt-core/src/hardware-capabilities.mjs and packages/kratt-core/src/linux-operations.mjs exist on feature/hardware-aware-runtime-v0.2.0-2026-11-07 |
| Feature branch vs main | GitHub compare reports diverged, 31 commits ahead and 73 behind, with merge base ed31e746d1820228cd8339b86e8957a6820dbc21 |
| PR #12 | Open, not marked Draft by GitHub metadata; base is work/kratt-prime-roadmap-v3-2026-11-06; GitHub reports mergeable=false |
| PR #13 | Previously confirmed merged into the PR #12 feature branch, not into main |

## Interpretation (not a verified owner decision)

The evidence is consistent with a repository containing an AURA-oriented default branch and a separately developed KRATT PRIME runtime line. It is not yet established whether this is intentional monorepo evolution, an incorrect repository target, or an incomplete integration.

## Safe decision

1. Keep main unchanged.
2. Preserve PR #12 and every existing Draft PR.
3. Treat feature/hardware-aware-runtime-v0.2.0-2026-11-07 as the current KRATT runtime code source for stacked engineering work only.
4. Keep new runtime fixes on child branches based on that feature ref, with Draft PRs targeting that same feature ref.
5. Do not open a runtime PR against main until the intended source-of-truth relationship is confirmed and a reviewed reconciliation plan exists.
6. Do not copy AURA root-level package metadata into KRATT packages or vice versa.

## Evidence and limitations

- Repository metadata, README and package manifest were read through GitHub using the antonioportfelli-boop account.
- The GitHub compare endpoint supplied commit counts, merge base and changed-path inventory. No local clone, git status, git merge-base, three-way merge simulation, or local test execution is claimed.
- This report records a point-in-time observation. Re-check branch tips and PR metadata before any future integration.

## Acceptance criteria for closing P0

- [ ] Owner confirms canonical KRATT PRIME integration target.
- [ ] Repository identity and product boundaries are documented.
- [ ] Exact source branch and target branch are agreed.
- [ ] Divergent history is reconciled through a reviewed, reversible strategy.
- [ ] CI runs on the intended integration target.
- [ ] No Draft PR, user commit, or main-branch history is lost.