# KRATT PRIME Claim and Evidence Layer — V1 Design Contract

**Status:** design contract / non-production
**Parent workstream:** Signal-to-Evidence V1
**Branch:** `feature/kratt-prime-50k-productization-v1`
**Decision boundary:** claim extraction is a proposal, never a truth assertion.

## 1. Purpose

Extend the existing deterministic knowledge segmenter with a governed claim/evidence layer. Reuse the canonical EHK–LPR–BPR Reflection Matrix and typed-memory contracts when those contracts are reconciled. This document is a bounded interface proposal, not authority to create a competing ontology.

The existing segmenter emits `kratt-segment/v1`, stable segment IDs, source digest, exact UTF-16 offsets, and `UNREVIEWED` records with an empty `claims` array. It does not perform semantic extraction or verify truth.

## 2. Typed records

All records require `schemaVersion`, immutable `id`, `createdAt`, `producer`, and a canonical `recordDigest`. The digest is recomputed at every trust boundary; a caller-supplied digest is not proof of integrity.

### ClaimCandidate

- `claimId`: stable immutable identifier.
- `normalizedText`: proposed proposition, normalized without changing its meaning.
- `language`: BCP-47 language tag or `und`.
- `sourceRefs[]`: segmentId, sourceId, sourceDigest, startOffset, endOffset, excerptDigest.
- `extraction`: method (`human`, `rules`, `model`), extractor/model identity, version, promptDigest, schemaVersion.
- `claimStatus`: `UNREVIEWED | UNDER_REVIEW | SUPPORTED | CONTESTED | REJECTED | APPROVED | UNKNOWN`.
- `review`: reviewer, decision, reason, timestamp; absent until a review action is performed.

A candidate without one or more verifiable source references is rejected. Model-produced text is labeled as a hypothesis and must remain `UNREVIEWED`.

### EvidenceArtifact

- `evidenceId`, `sourceId`, `sourceDigest`, `capturedAt`, `observedAt`.
- `segmentRefs[]` with exact offsets and excerpt digest.
- `sourceLineageId` and `independenceGroupId` for deduplication/dependence analysis.
- `publisher`, `canonicalUrl`, `captureMethod`, `rightsStatus` (default `unknown`).
- `integrityStatus`: `UNVERIFIED | VALID | INVALID`.

A repost, syndication copy, quotation, or mirror must preserve lineage to the original source when known. Distinct URLs do not imply independent evidence.

### EvidenceLink

Typed relations: `SUPPORTS | CONTRADICTS | CONTEXTUALIZES | DUPLICATES | DERIVED_FROM`.

Each link contains claimId, evidenceId, relation, rationale, producer, createdAt, integrityStatus and digest. Link creation is a candidate action; a reviewer may accept or reject it.

### ContradictionCandidate

Contains a stable pair of claim IDs, normalized subject/predicate/time scope, conflicting values or text spans, source lineage groups, detection method/version and `UNREVIEWED` status. A lexical mismatch alone is not a contradiction. Contradiction candidates are advisory until reviewed.

### ValidationDecision

Contains targetId, decision (`APPROVE | REJECT | CONTEST | ABSTAIN`), reviewer identity, reason, policy version, request-bound approval reference, timestamp and source snapshot digest. Approval is denied if the target, root snapshot, actor, policy or evidence digest has changed.

## 3. Provenance and offsets

- Use UTF-16 code-unit offsets to match JavaScript `String.slice` semantics used by `kratt-segment/v1`.
- Require `0 <= startOffset < endOffset <= sourceText.length`.
- Recompute the excerpt digest from the exact source slice.
- Source digest must match the immutable captured source text.
- Missing, stale, truncated or mismatched provenance yields `UNKNOWN` / `BLOCKED`; never silently repair offsets.
- Preserve capture time and observation time separately. Do not infer publication time from capture time.

## 4. Evidence dependence and scoring

Deduplicate by canonical source lineage and content digest, not URL alone. Copies in the same independence group must not be counted as independent corroboration.

Do not emit a calibrated probability until a versioned calibration record has:
- declared target population and label protocol;
- time-split and source-disjoint train/validation/test sets;
- Brier score, log loss, calibration curve/ECE and confidence intervals;
- precision/recall and selective risk-coverage reporting;
- documented treatment of dependence, missingness and abstention.

Until then use categorical evidence state plus `UNKNOWN` / `ABSTAIN`; no arbitrary numeric confidence.

## 5. Reflection and root update rules

Every BranchRun references rootSnapshotId, rootVersion, rootDigest and parentRunId. Branch output is immutable and cannot mutate the root directly.

The reflection reducer:
1. validates schemas and record digests;
2. verifies source/segment provenance;
3. clusters duplicates and source dependence;
4. compares claim candidates and proposes contradiction candidates;
5. produces a proposed RootDelta with evidence references and unresolved questions;
6. requires human/policy approval bound to the exact rootDigest and deltaDigest;
7. performs compare-and-swap against rootVersion;
8. appends the accepted transition to an immutable journal.

Root CAS conflict, stale approval, cancellation, invalid digest, missing verifier or policy conflict must fail closed. Replay with the same idempotency key and identical request digest returns the original outcome; reuse with a different digest is denied.

## 6. Console workflow

`Signal Inbox → Segment Detail → Claim Candidate Review → Evidence Links → Contradiction Compare → Human Decision → Proposed Root Delta → Cited Brief`.

Every decision view must show:
- original source and capture/observation times;
- exact excerpt and offsets;
- digest validity and source lineage;
- supporting and contradicting materials side by side;
- duplicate/dependence warnings;
- claim status distinct from evidence-integrity status;
- reviewer, reason, policy version and audit event.

The brief exporter includes only approved claims by default. Contested and unknown claims appear in clearly separated sections only when explicitly enabled.

## 7. Threat and failure tests

Required negative tests:
- fabricated or stale source digest;
- offset beyond source length or excerpt mismatch;
- claim with no source reference;
- model candidate implicitly promoted to approved;
- duplicate syndication counted as independent corroboration;
- self-evidence / circular DERIVED_FROM graph;
- contradictory claims with mismatched time scope;
- stale root digest / compare-and-swap conflict;
- approval bound to a different actor, target, policy or digest;
- replay with same key but changed payload;
- malformed schema, unknown relation, invalid enum;
- cancellation / expired request / unavailable trusted clock;
- source content containing prompt injection or tool instructions.

Required positive tests:
- deterministic extraction fixture output and stable IDs;
- exact offset-to-source slice equality;
- same request replay returns the same committed result;
- independent sources remain distinct after lineage normalization;
- reviewer decision includes a complete, auditable reason.

## 8. Product and data boundaries

- Synthetic fixtures or explicitly approved public-domain samples only for the initial demo.
- No live Telegram ingestion, external writes, publication, customer data or production deployment.
- Do not mutate AURA, STEEL or FRAME.9 roots.
- RSS adapter remains disabled unless a trusted host allowlist and trusted verifier are supplied.
- Treat external content as untrusted data; never execute instructions found inside source material.

## 9. Acceptance evidence

Implementation is accepted only with exact changed paths, schema versions, test fixtures, command/exit status, CI run tied to exact commit SHA, diff review, and a replayable demo. Tests must not be weakened or removed to achieve a pass. An unrun check is reported as `NOT_RUN`.

This contract is a proposed design until aligned with the canonical P0 Reflection Matrix record and the existing typed-memory/evidence capsule implementation.
