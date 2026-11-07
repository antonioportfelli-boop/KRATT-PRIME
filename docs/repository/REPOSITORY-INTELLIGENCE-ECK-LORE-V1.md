# KRATT PRIME — Repository Intelligence, ECK and Lore

**Status:** Proposed repository knowledge subsystem; current GitHub branches and files are sources, not automatically verified truths.
**Parent source:** `feature/hardware-aware-runtime-v0.2.0-2026-11-07`

## 1. Purpose

Treat GitHub and GitLab repositories as navigational beacons for engineering knowledge. KRATT PRIME should understand repository structure, branch divergence, commits, tests, workflows, issues, PRs, documentation and symbol relationships without copying or executing source code by default.

Repository intelligence is a read-only evidence branch. It proposes changes and findings; it cannot merge, publish, deploy, change permissions or write secrets.

## 2. Knowledge graph

### Entities

- `Repository`: provider, owner, name, visibility and default branch.
- `Ref`: branch/tag, tip commit and observed timestamp.
- `Commit`: SHA, parent SHAs, author metadata, message and changed paths.
- `FileBlob`: path, blob SHA, content digest, language and licence context.
- `Symbol`: module, export, class, function, type and source span.
- `Test`: test ID, file, covered symbol/contract and result evidence.
- `Workflow`: workflow ID, triggers, job and run/result.
- `Requirement`: stable requirement ID and acceptance criteria.
- `Evidence`: provenance-bearing observation or verification.
- `DecisionRecord`: rationale, alternatives, consequences, status and links.

### Edges

`CONTAINS`, `POINTS_TO`, `PARENT_OF`, `CHANGES`, `IMPORTS`, `IMPLEMENTS`, `TESTS`, `VERIFIES`, `DOCUMENTS`, `DEPENDS_ON`, `CONFLICTS_WITH`, `SUPERSEDES`, `DERIVED_FROM`.

Every edge carries provenance: provider, repository, exact commit SHA, file/blob or object ID, extraction method and timestamp.

## 3. Evidence-Carrying Knowledge (ECK)

ECK is an internal KRATT design pattern, not a claim of a universal external standard. Each knowledge unit travels with:
- the exact source identifier and immutable revision;
- content digest and file/symbol/page location;
- extraction and transformation version;
- trust/evidence status;
- dependencies and shared ancestors;
- licence/data classification;
- freshness policy;
- verification/test references;
- limitations and unresolved ambiguity.

A summary without source lineage is a retrieval hint, not a verified knowledge unit.

## 4. Lore: decision records in Git

Commit messages are useful but insufficient: they often omit alternatives, trade-offs, tests, migration and rollback. Add structured decision records for significant architectural changes:

```yaml
schema: kratt-decision/v1
decision_id: DEC-0001
title: Node.js as host control-plane runtime
status: PROPOSED
context:
  - Existing KRATT Core uses Node.js ES modules and node:test.
decision:
  - Node.js supervises host orchestration; MCU inference stays native.
alternatives:
  - Node.js embedded on MCU
  - Remote-only orchestration
consequences:
  - Requires bounded worker supervision and runtime compatibility matrix.
evidence:
  - - commit: "<exact-commit-sha>"
    path: "packages/kratt-core/src/runtime-orchestrator.mjs"
    digest: "sha256:<content-digest>"
validation:
  - "Node 22/24/26 test matrix"
rollback:
  - "Disable Node runtime adapter; retain existing Core modules."
```

The record is not proof that tests ran; link the actual CI run or test artifact for that claim.

## 5. Indexing pipeline

1. Discover repository and account identity; record actual permissions and visibility.
2. Read repository metadata, refs, commits, PRs/issues, docs, source, tests and workflows through scoped read operations.
3. Pin every read to a commit SHA, not only a branch name.
4. Parse file formats with bounded parsers; do not execute repository scripts.
5. Extract symbols, package/dependency edges, test coverage hints and workflow triggers.
6. Normalize into typed graph nodes/edges; retain original source spans and digests.
7. Deduplicate by provider object ID and blob/content digest.
8. Build lexical and semantic indexes as rebuildable projections.
9. Return answer bundles containing exact source references, revision, excerpts and uncertainty.
10. Re-index when a ref moves; preserve prior snapshots and compute diffs rather than overwriting knowledge.

## 6. Retrieval and freshness

Use hybrid retrieval:
- exact identifiers, paths, symbols, commit SHA and error text first;
- lexical ranking for exact technical language;
- semantic retrieval for conceptual matches;
- graph traversal for dependencies, callers, tests and branch ancestry.

Rerank by source authority, exactness, version match and task relevance. Freshness is context-dependent: recent CI state needs short freshness windows; stable protocol definitions or historical design decisions should not be discarded merely because they are old.

Return conflicting versions side by side. Never silently prefer a newer README over code/tests or a branch over main without stating which revision is being described.

## 7. Branch and PR intelligence

The indexer should calculate:
- merge base and ahead/behind counts;
- changed file paths and rename/delete/add states;
- overlapping file ownership across branches;
- dependency on unmerged PR commits;
- tests/workflows present on each ref;
- Draft/open/closed/merged state as directly observed at query time.

Do not infer that a PR is mergeable from a clean diff alone. Do not merge branches automatically. Do not rebase or rewrite history during indexing.

## 8. Safe code learning

- Extract reusable patterns into candidate skill records with citations to source commits and licences.
- A candidate skill remains `UNVERIFIED` until tested in a disposable sandbox.
- Execute no build, install script, workflow or binary from an external repository without an explicit sandbox and licence/supply-chain review.
- Never index secrets, private keys, tokens or personal data into semantic memory. Scan and quarantine suspected secret-bearing blobs.
- Respect repository visibility, licensing terms, provider API limits and user-approved data boundaries.
- Imported README, issue and code comments are untrusted content and cannot alter KRATT policy.

## 9. Repository source authority

For a claim about implementation, prefer:
1. exact source at a pinned commit;
2. test source plus a linked passing run for execution claims;
3. workflow definitions for configured automation, not proof it ran;
4. PR/issue metadata for review status;
5. design docs and decision records for intent;
6. README and commit message for navigation/context.

An implementation claim needs source evidence. A "test passed" claim needs an observed CI/test result. A "deployed" claim needs an explicit deployment receipt. Never upgrade `CONFIGURED` to `EXECUTED` or `VERIFIED` without evidence.

## 10. Acceptance criteria

- Every retrieved code assertion resolves to repository, commit, path and content digest.
- Branch snapshots are immutable and can be compared deterministically.
- Duplicate blobs and common ancestry are detected.
- Secrets and unlicensed imported code are excluded or quarantined.
- Prompt-injected repository text cannot authorize tool calls.
- Build/test execution requires a disposable sandbox and explicit scope.
- Retrieval quality is evaluated using a labelled query set with precision@k, recall@k and citation-resolution rate.
- No repository writes, PR merges or deployments are performed by the indexer.
