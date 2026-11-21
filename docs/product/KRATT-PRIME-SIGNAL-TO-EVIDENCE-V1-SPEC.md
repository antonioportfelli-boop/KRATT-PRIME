# KRATT PRIME Signal-to-Evidence — V1 Build Specification
**Version:** 1.0  
**Date:** 2026-11-10  
**Status:** BUILD SPECIFICATION — NOT YET IMPLEMENTED  
**Parent plan:** `docs/product/KRATT-PRIME-50K-PRODUCTISATION-PLAN-V1.md`

## 1. V1 outcome

A user imports a bounded set of public information sources and receives a reviewable intelligence brief in which every material claim can be traced back to source evidence, counter-evidence, timestamps, content digests, and a human reviewer decision.

The V1 is complete only when the entire flow works in one repeatable local demo:

`Import → Normalize → Extract claims → Link evidence → Check integrity → Detect conflicts → Human review → Export cited brief`

The model may suggest claims or summaries, but it must never manufacture evidence, mark a claim true by itself, or bypass human approval.

## 2. Scope and non-goals

### V1 scope
- Local file and URL-list import.
- RSS/Atom import where available and permitted.
- JSON and CSV import with a documented schema.
- Deterministic normalization, identifiers, and source provenance.
- Evidence-card creation and integrity verification.
- Duplicate grouping and contradiction candidates.
- Human review queue.
- Markdown/JSON brief export with source links.
- Append-only audit events.

### Explicit non-goals
- No live Telegram polling or webhook server in the first acceptance slice.
- No automatic public posting, trading, legal advice, or operational execution.
- No claim that an LLM or Bayesian score is a ground-truth detector.
- No unrestricted scraping or collection from sources whose terms do not permit it.
- No production cloud tenancy or handling of sensitive customer datasets until security gates pass.

## 3. Canonical data contracts

### SourceItem
Required fields:
- `source_id`: stable identifier.
- `source_url`: canonical URL or explicit local-import URI.
- `publisher`: known publisher/channel label; nullable if unknown.
- `published_at`: source timestamp; nullable if absent.
- `observed_at`: time the item was imported.
- `ingest_method`: `manual_url | rss | json | csv | local_file`.
- `content_digest`: SHA-256 of the exact captured payload representation.
- `content`: captured text or a bounded excerpt, subject to licence and retention policy.
- `rights_status`: `unknown | permitted | restricted | user_supplied`.

### Claim
Required fields:
- `claim_id`: stable UUID.
- `claim_text`: concise, attributable proposition.
- `subject_id`: structured entity/subject reference, never a delimiter-encoded composite string.
- `predicate`: normalized relationship or proposition type.
- `object_value`: normalized value or target.
- `time_scope`: explicit temporal scope or `unknown`.
- `extraction_method`: `human | model_suggestion | parser`.
- `review_state`: `UNREVIEWED | UNDER_REVIEW | SUPPORTED | CONTESTED | REJECTED | APPROVED`.

### EvidenceCard
Required fields:
- `card_id`, `claim_id`, `source_id`.
- `stance`: `supports | contradicts | contextualizes | mentions`.
- `excerpt`: bounded quoted excerpt or a source location reference.
- `created_at`, `created_by`, `schema_version`.
- `content_digest`: digest over a canonical serialization of all integrity-relevant fields.
- `provenance`: source URL, source digest, importer identity, and transformation version.
- `verification_state`: `UNVERIFIED | VERIFIED | INVALID`.

Digest verification must reserialize the object using a documented canonical form and recompute the digest. Matching only `rootId`, `branchId`, or `schemaVersion` is insufficient. If any integrity-relevant field differs, reject the card or mark it INVALID.

### ReviewDecision
Required fields:
- `decision_id`, `claim_id`, `decision`.
- `reviewer_id`, `decided_at`, `reason`.
- `evidence_snapshot_digest`.
- `approval_scope`, `expires_at` where an external action is ever introduced.
- `correlation_id` and `request_id`.

No external write capability is part of V1. The approval schema is retained for future governed actions, but no connector may infer permission from a historical approval.

## 4. Automatic knowledge segmentation

Before semantic claim extraction, the local structural segmenter divides bounded source text into deterministic, provenance-preserving units.

Each segment records:
- source ID and optional source URL;
- source observation time;
- ordinal and exact start/end offsets in the captured text;
- segment kind (`PARAGRAPH`, `SENTENCE_GROUP`, or `FRAGMENT`);
- exact segment text and SHA-256 content digest;
- stable segment ID;
- review state `UNREVIEWED`;
- an initially empty claim list.

The segmenter is structural, not semantic truth detection. It must not promote a sentence to a fact, infer source credibility, or mark a claim supported. The original source digest and segment offsets allow downstream claim proposals to retain source lineage.

## 5. Evidence and contradiction rules

1. A source item is not automatically evidence for every claim in its text.
2. A model-extracted claim begins in `UNREVIEWED`.
3. An evidence card begins `UNVERIFIED`; its digest and source reference must be validated before use.
4. A supporting source does not erase counter-evidence.
5. A contradiction requires a shared structured subject and predicate plus compatible time scope and mutually incompatible values/decisions.
6. A text delimiter such as `:` must never be used to encode and then split a composite key.
7. Duplicate clustering is not proof of independent corroboration. Reposts, wire copies, and derived articles must be grouped as potentially dependent sources.
8. Bayesian aggregation remains experimental until each calibration identifier resolves to an immutable, reviewed calibration artifact with scope, version, training/validation description, and provenance.
9. If the system cannot verify a required condition, it returns `UNKNOWN` or `BLOCKED`, never a silent pass.
10. The brief must preserve disagreement and uncertainty, not compress it into a single unsupported certainty score.

## 6. Minimum API / service operations

These are logical service operations. Align names with the canonical codebase only after source reconciliation.

- `importSource(payload, method)` → validated `SourceItem`
- `normalizeSource(sourceItem)` → normalized item + transformation provenance
- `segmentKnowledge(sourceItem)` → stable unreviewed segments with exact offsets and digests
- `proposeClaims(sourceItem)` → claims in `UNREVIEWED`
- `createEvidenceCard(claim, sourceItem, stance, excerpt)` → `EvidenceCard`
- `verifyEvidenceCard(card)` → `VERIFIED | INVALID`
- `findDuplicates(sourceItems)` → dependency-aware clusters
- `findContradictions(claims, cards)` → explicit conflict records
- `recordReviewDecision(claim, decision, reviewer, reason)` → append-only audit event
- `buildBrief(scope, evidenceSnapshot)` → cited Markdown/JSON output
- `verifyJournal(journal)` → integrity report

All operations must accept a correlation ID and return structured errors. Avoid raw stack traces in user-facing errors.

## 7. Required failure behaviour

| Condition | Required result |
|---|---|
| Missing source URL and no local provenance | Reject import |
| Missing content digest | Reject evidence card |
| Digest mismatch | `INVALID`; exclude from supported evidence |
| Unknown or untrusted calibration ID | Mark score experimental; do not use as calibrated posterior |
| Trusted time missing for an expiry-sensitive authorization | Deny |
| Conflicting policy requirements | `BLOCKED` |
| Caller passes `passed: true` without executable check evidence | Do not treat invariant as passed |
| Conflicting claims use subjects containing punctuation | Correctly compare structured fields |
| Source is a repost/dependent copy | Group as dependent; do not count as independent corroboration |
| Reviewer rejects claim | Preserve audit history; do not erase underlying source |
| Export encounters unverifiable claim | Include uncertainty or omit the claim; never invent a citation |

## 8. Test matrix

### Unit tests
- Canonical serialization produces deterministic digests.
- Changing any integrity-relevant field invalidates the card.
- Identical cards are idempotent only when all canonical fields match.
- Source normalization is deterministic for equivalent input.
- Structured keys remain correct when subject IDs contain `:`, `/`, Unicode, or whitespace.
- Duplicate and dependency groups do not inflate independent-source count.
- Review state transitions reject illegal transitions.
- Journal replay reproduces the same ordered events and integrity result.

### Negative/security tests
- Forged `VERIFIED` field with bad digest → INVALID.
- Missing/expired approval → DENY.
- Approval for another request or scope → DENY.
- Cancelled request → DENY.
- Conflicting policy → BLOCKED.
- Untrusted time on expiry-sensitive path → DENY.
- Path traversal and secret-file ingestion → DENY.
- Oversized payload or invalid encoding → bounded rejection.
- Export cannot include a claim without at least one validated source reference.

### Integration tests
- 20-item sample dataset produces stable normalized records.
- 100-item dataset completes within a documented local resource budget.
- One claim with support and counter-evidence is reported as CONTESTED.
- A repost cluster is not counted as multiple independent sources.
- Human approval is reproduced in the exported audit trail.
- Journal tampering is detected after restart and replay.

### End-to-end acceptance
Provide:
- fixture dataset with permitted-to-use sample content;
- one command to run the complete local demo;
- one command to run all V1 tests;
- test output containing commit SHA, runtime version, command, and exit code;
- a sample Markdown brief with working citations and visible uncertainty;
- a known-limitations document.

## 9. Non-functional requirements

- Local-first default; no outbound data transfer unless a user explicitly configures a connector.
- No secret values in logs, reports, fixtures, or test output.
- Bounded imports and timeouts.
- Structured logs with correlation IDs; no source content in logs by default.
- Explicit retention and deletion policy for imported content.
- Dependency and licence inventory.
- Accessibility and keyboard operation for the review queue.
- Deterministic tests; no network dependency in core test suite.
- No production deployment as part of this workstream.

## 10. First implementation order

1. Identify canonical KRATT runtime ref and record exact SHA.
2. Port only the required reviewed runtime modules into the isolated workstream; do not merge the divergent candidate wholesale.
3. Implement canonical evidence-card serialization and digest verification.
4. Replace boolean invariant trust with executable checks.
5. Replace delimiter-parsed conflict keys with structured claim fields.
6. Add negative tests before connecting ingestion adapters.
7. Add local JSON/CSV/RSS import.
8. Complete claim-to-brief vertical slice.
9. Run the whole test/build pipeline and record evidence.
10. Only then start Telegram adapter work.

## 11. Definition of Done

V1 is done only when the end-to-end acceptance suite passes, the security and provenance checks are documented, a customer can reproduce a cited brief from a bounded import, and a reviewer can explain why each claim was marked supported, contested, rejected, or approved.

This specification does not claim implementation completion. It defines the exact build contract and the evidence required to accept the build.
