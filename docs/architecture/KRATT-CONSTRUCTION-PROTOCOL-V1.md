# KRATT Construction Protocol v1

Status: experimental, isolated feature-branch implementation.

## Purpose

Represent a proposed code change as an evidence-bearing task with explicit review, implementation, and independent verification states. This module is workflow bookkeeping only. It does not authorize tools, execute code, approve GitHub writes, or grant production access.

## State machine

`PROPOSED -> IN_REVIEW -> APPROVED -> IMPLEMENTED -> VERIFIED`

A task may be blocked or cancelled where the transition table permits it. An implemented task may return to review when verification fails. Terminal `VERIFIED` and `CANCELLED` states cannot transition further.

## Required boundaries

- Every task records its base commit, target paths, builder identity, and required evidence labels.
- The builder cannot approve or verify their own task.
- Approval and verification require non-empty evidence references.
- Implementation requires a SHA-256 change digest.
- Invalid input and illegal transitions fail closed.
- The protocol records evidence references but does not authenticate evidence. A trusted host must verify referenced test runs, reviews, signatures, and repository state.
- No task created by this module receives implicit permission to write a repository, change protected branches, deploy, or modify its own policy.

## Files

- `packages/kratt-core/src/construction-protocol.mjs`
- `packages/kratt-core/test/construction-protocol.test.mjs`

## Validation status

Tests were authored but have not been executed in this environment. Do not treat the module as production-ready until the repository test suite and type/build checks pass in CI.

## Existing source-of-truth blocker

The current `main` versions of `packages/kratt-core/src/policy.mjs` and `packages/kratt-core/src/contracts.mjs` contain duplicate declarations visible in the fetched source. These must be reconciled against the existing WP-01 branches and their tests before replacing either file. This feature deliberately does not overwrite those files or merge parallel work.


## Reflection engine v1

`packages/kratt-core/src/reflection-engine.mjs` produces a deterministic report from observations supplied by the trusted host after provenance validation.

- Distinguishes complete evidence, missing evidence, failed checks, and readiness for independent verification.
- Emits a bounded rework proposal only; it does not create a task, execute tools, or change task state.
- Does not authenticate evidence. Never pass request- or model-authored observations without trusted verification.
- A complete report on an IMPLEMENTED task recommends independent verification; only a VERIFIED task with all required evidence is reported COMPLETE.

Focused tests: `packages/kratt-core/test/reflection-engine.test.mjs`.

Validation remains pending: tests have been authored but have not been executed in this environment.
