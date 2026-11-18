# MÕTLEMINE v1

MÕTLEMINE turns structured evidence assessments into an inspectable reasoning report. It is deterministic and intentionally narrow: it does not generate facts, infer evidence polarity from raw text, or grant authorization.

## Input model

An analysis contains:
- a stable analysis ID;
- claims with stable claim IDs, statements, dependencies and evidence assessments;
- evidence IDs linked to KRATT evidence records;
- one trusted \`verifyEvidence(record, context)\` callback.

Each assessment carries a \`SUPPORTS\` or \`REFUTES\` stance plus a rationale code. Those labels are authored by the upstream assessor and are not treated as verified evidence. Only a structurally valid evidence record with \`result: VERIFIED\` that also passes the trusted verifier is counted.

## Decision rules

The default corroboration threshold is two independent sources. Independence is counted by \`(source_type, source_id)\`, so duplicates from one source do not increase corroboration.

- \`SUPPORTED\` — support meets the independent-source threshold and no refuting source is present.
- \`REFUTED\` — refutation meets the threshold and no supporting source is present.
- \`CONFLICTED\` — support and refutation both exist; report distinguishes same-source stance conflict from independent contradiction.
- \`INSUFFICIENT_EVIDENCE\` — neither side meets the threshold.
- \`BLOCKED\` — a dependency is cyclic or a prerequisite claim is not supported.

The overall report is \`READY_FOR_REVIEW\`, \`EVIDENCE_INCOMPLETE\` or \`REVIEW_REQUIRED\`. It includes per-claim evidence IDs, independent source counts, unverified evidence IDs, reason codes and a report digest.

## Safety boundary

The report contains \`policy_authority: false\`. A \`SUPPORTED\` claim is not a KRATT \`ALLOW\` decision. KRATT policy, trusted evidence loading, request-bound approvals and durable reservation remain separate mandatory controls.
