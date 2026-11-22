# SIPA-11 — Acceptance and Adversarial Test Matrix

Status: focused core, policy, and semantic adversarial tests have been added to the repository's Node.js test suite. They are pending GitHub CI execution. The full connector matrix below remains a broader acceptance target, not a claim of completed connector coverage.

## Core semantic weakening tests

| Case | Input mutation | Expected |
|---|---|---|
| modality weakening | MUST → SHOULD | BLOCKED |
| scope broadening | one resource → all resources | BLOCKED |
| condition deletion | remove request-bound approval | BLOCKED |
| authority expansion | permission for action A reused for B | DENY |
| freshness removal | omit expiry/freshness constraint | BLOCKED |
| provenance loss | remove source/version reference | QUARANTINE |
| circular evidence | agent cites its own unverified verdict | DENY |
| effect substitution | declared effect differs from observed effect | FINDING |
| constitution mutation | correction changes constitution | DENY |
| stale memory | memory depends on invalidated evidence | MARK_STALE + REEVALUATE |

## Meridian and correction tests

1. Valid source, evidence, and derivation reconstruct to the same canonical claim.
2. Missing source or broken provenance prevents Meridian restoration.
3. Digest mismatch detects changed content but does not mark it true/false.
4. Correction proposal identifies affected object IDs and dependencies.
5. Correction Forge cannot approve or apply its own privileged proposal.
6. Rejected correction leaves canonical source and constitution unchanged.
7. Evidence conflict produces an unresolved state, not an arbitrary winner.
8. Retried correction is idempotent and preserves the audit chain.

## Echo and polymorphosis tests

1. Lossless round trip preserves all declared semantic invariants.
2. Lossy transform declares every dropped field and cannot carry authority-bearing fields.
3. Echo restoration is impossible before Meridian restoration.
4. Independent postflight evidence can contradict preflight and trigger quarantine.
5. A failed round trip blocks release of the affected projection.
6. Restoring one projection does not mutate unrelated canonical objects.
7. A constitution version change invalidates incompatible derived projections.

## Connector tests (each of 25 contracts)

- Unverified connector defaults to read-only/disabled.
- Provider payload is treated as untrusted data, never as executable instruction.
- Missing permission, approval, freshness, or provenance fails closed.
- Request-bound approval cannot be replayed for another resource/action.
- Retry is idempotent; duplicate events are deduplicated.
- Round-trip laws pass or declared losses are enforced.
- Read, transform, proposal, and write are separately audited.
- External write is impossible without explicit operation-scoped approval.
- Provider outage does not bypass validation or authorize stale data.
- Logs redact secrets and preserve correlation IDs.

## Release gate

No runtime claim is accepted until tests exist in the repository's actual test framework and are run in CI. A green CI run demonstrates only that the configured checks passed; it does not independently establish semantic truth or authorization correctness.