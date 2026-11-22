# SMF-01 — Acceptance Test Matrix

| Area | Adversarial input | Expected result |
|---|---|---|
| Identity | Missing one of five semantic dimensions | Reject identity |
| Identity | Getter/accessor or unsupported object | Reject without executing accessor |
| Canonicalization | Key order differs | Identical canonical digest |
| Anti-semantics | Meaning/principle/effect/authority changes | Counterexample candidate |
| Anti-semantics | No candidates supplied | Inconclusive; never imply proof |
| Polymorphosis | Complete mapping and lossless round trip | Transformed, no authority grant |
| Polymorphosis | Changed authority or core dimension | Blocked |
| Polymorphosis | Protected field declared lossy | Blocked |
| Polymorphosis | Top-level source field silently omitted | Blocked |
| Talmud | Provenance/evidence/authority/conflict gate fails | Blocked |
| Anti-Talmud | Independent postflight evidence missing | Quarantine |
| Anti-Talmud | Observed effect differs from expected | Finding |
| Correction Forge | Verified source and explicit invariants | Proposal only; no self-approval |
| Echo | Meridian, approval or invariants not restored | Quarantine/blocked |
| Meridian | Valid transform audit event | Append provenance-linked node |

## Release conditions

- [ ] All SMF-01 unit tests pass on the target feature branch.
- [ ] Existing KRATT core tests remain green.
- [ ] Typecheck and production build pass in CI.
- [ ] Security review confirms the preflight evidence booleans originate from trusted verifiers.
- [ ] Transform profiles are reviewed individually; lossy mappings cannot carry protected authority fields.
- [ ] No external write path is enabled by SMF-01.
- [ ] Draft PR remains unmerged pending review.
