# SIPA-11 — Bidirectional Mirror Contract Registry

Status: proposed contracts. Provider account access, permissions, endpoint availability, and each adapter's implementation are not implied by this document.

## Shared contract

Every mirror declares stable contract ID/version; source provider/resource reference; canonical object type/schema version; inbound and outbound mapping; preserved semantic invariants; provenance and freshness requirements; round-trip law or explicit loss declaration; read/write scope and approval policy; idempotency/retry behavior; fail-closed behavior for authority-bearing data; audit event and test references.

A mirror never grants authority. A successful read or transform is not approval to write.

## Round-trip requirements

For lossless mappings:
- GetPut: reading a source and writing back the unchanged representation does not alter the source.
- PutGet: writing a valid canonical update and reading it back yields the accepted update.
- Invariant preservation: subject, scope, modality, conditions, authority, provenance, and effect remain unchanged.

For lossy mappings, list every dropped field and prohibit use for authority-bearing decisions unless a separately approved safe mapping exists.

## 25 contracts

### GitHub — source and implementation evidence

1. github.repository-mirror: repository refs, manifests, and source versions ↔ canonical source records.
2. github.commit-diff-mirror: commit/diff evidence ↔ semantic change findings.
3. github.contract-mirror: code/schema contracts ↔ canonical invariant definitions.
4. github.ci-evidence-mirror: workflow/check results ↔ evidence records; status is not proof of correctness.
5. github.correction-pr-mirror: approved correction proposals ↔ feature-branch/draft-PR artifacts; never auto-merge.

### Asana — requirements and work tracking

6. asana.requirement-mirror: requirement/task source ↔ canonical requirement.
7. asana.approval-mirror: approval record ↔ request-bound approval evidence; task completion alone is not approval.
8. asana.dependency-mirror: task dependencies ↔ impact graph.
9. asana.acceptance-mirror: acceptance criteria ↔ testable invariants.
10. asana.correction-workflow-mirror: correction case ↔ tracked remediation workflow.

### Consensus — research evidence

11. consensus.query-mirror: claim and research question ↔ reproducible search specification.
12. consensus.paper-provenance-mirror: paper metadata ↔ source/provenance record.
13. consensus.fulltext-evidence-mirror: accessible paper passages/results ↔ evidence excerpts with limitations.
14. consensus.contradiction-mirror: conflicting findings ↔ contradiction cases.
15. consensus.quality-mirror: study design/limitations ↔ evidence-quality assessment.

### Firecrawl — web-source acquisition

16. firecrawl.discovery-mirror: bounded discovery request ↔ candidate source records.
17. firecrawl.snapshot-mirror: URL/content snapshot ↔ timestamped source evidence.
18. firecrawl.crawl-mirror: bounded crawl graph ↔ source dependency graph.
19. firecrawl.structured-data-mirror: extracted fields ↔ validated canonical schema.
20. firecrawl.change-detection-mirror: source-version change ↔ stale-evidence and revalidation events.

### Vercel — runtime observations

21. vercel.runtime-log-mirror: logs/correlation IDs ↔ action evidence.
22. vercel.runtime-error-mirror: error events ↔ defect/finding records.
23. vercel.trace-mirror: trace spans ↔ causal execution graph.
24. vercel.agent-run-mirror: agent run/tool-call records ↔ declared-vs-observed behavior evidence.
25. vercel.security-review-mirror: security findings ↔ affected invariant and correction case.

## Rollout gate

Each contract remains DISCOVERED until endpoint, account, scope, and data handling are verified. Then progress through the existing lifecycle: CONNECTED_UNVERIFIED → VERIFIED_READ_ONLY → WRITE_PENDING_APPROVAL → WRITE_ENABLED. Write enablement is per operation and requires explicit authorization. Failed validation transitions to DISABLED or ERROR, not to a permissive fallback.