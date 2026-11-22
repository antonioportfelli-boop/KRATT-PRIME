# SIPA-11 — Semantic Integrity, Polymorphosis & Anti-Weakening Architecture

Status: design baseline on a feature branch; implementation and runtime behavior are not yet verified.

## Purpose

SIPA-11 detects semantic weakening before an action, independently audits outcomes after an action, reconstructs an evidence-backed Meridian chain, and only then proposes constitutional Echo restoration.

The system must distinguish content (what an object contains), meaning (what it denotes in a context), principle (the rule governing interpretation or behavior), effect (the observable consequence), and authority (the permission or control it confers). These dimensions are never interchangeable by default.

## Safety invariants

1. A transformation must not silently weaken a source requirement.
2. A semantic match is not proof of equivalent authority or effect.
3. Missing, stale, conflicting, or unverifiable evidence fails closed.
4. A correction cannot modify the system constitution or its authority boundary.
5. Constitution changes require a separately authorized, versioned change.
6. Anti-Talmud must not accept Talmud's own verdict as independent evidence.
7. Echo restoration is blocked until the Meridian source/evidence chain is restored.
8. Every finding, correction, transformation, and restoration is provenance-linked and auditable.
9. External writes require request-bound approval and the existing integration lifecycle.
10. Unverified adapters remain read-only or disabled.

## Engines

### Talmud Engine — preflight

Input: proposed action, source requirement, context, evidence references, authority scope, and planned transformations.

Checks: source/version known; conditions and scope preserved; modality, negation, temporal bounds, subject, and effect preserved; evidence trusted, relevant, and fresh; action authority explicitly scoped to this request; no unresolved contradiction or prohibited equivalence.

Output: PASS, BLOCKED, or NEEDS_EVIDENCE. Only PASS may proceed to the existing authorization/dispatch boundary; SIPA does not grant authority.

### Meridian Truth Chain

A provenance graph linking SOURCE → CLAIM → EVIDENCE → INTERPRETATION → CONSTITUTION → AUTHORIZATION → ACTION → OUTCOME → ECHO.

Each node carries stable identity, version, source reference, timestamp, actor, content digest, and validation state. Edges record derivation or transformation and its rule/version. A digest detects changes; it does not establish factual truth.

Meridian reconstruction requires source retrieval, integrity checks, provenance validation, and independent evidence review. If reconstruction fails, affected outputs stay quarantined.

### Anti-Talmud Engine — postflight

Inputs include observed outcomes and independent runtime evidence, not merely the preflight verdict.

Detect dropped constraints; weakened modality or broadened scope; unauthorized authority expansion; stale, missing, or circular evidence; divergence between declared and observed effects; mutation of canonical meaning or constitution; and contaminated memory derived from invalid interpretations.

A negative finding freezes dependent Echo projections and opens a Correction Forge case.

### Correction Forge

Produces a minimal, reviewable correction proposal with finding and affected object IDs; source/evidence references; exact before/after semantic dimensions; restored invariants; impact/dependency set; tests and expected outcomes; and required approval scope.

It cannot self-approve, self-apply privileged changes, or rewrite the constitution.

### Constitutional Echo Restorer

Runs only after Meridian is restored. It recomputes affected projections from canonical, evidence-backed data; preserves provenance; and performs round-trip checks. Any mismatch returns the affected projection to quarantine. Restoration means conformity to the authorized constitution version, not changing that constitution.

### Polymorphosis Transformation Fabric

Maps a canonical semantic object into platform-specific representations while preserving declared invariants. Each transform is versioned, provenance-linked, and tested in both directions where the target format permits lossless round trips. Lossy transforms must declare losses explicitly and may not carry authority-bearing fields across a lossy boundary.

### Semantic Memory Immunity

Memory entries inherit source, version, confidence, and dependency links. Invalidated evidence marks dependent memories and decisions stale; affected decisions are re-evaluated. Unprovenanced memories cannot become canonical policy.

## Decision flow

1. Talmud preflight.
2. Existing authorization and dispatch checks.
3. Observe actual outcome.
4. Anti-Talmud postflight.
5. If negative: quarantine affected projections and create correction proposal.
6. Restore Meridian from verified source/evidence.
7. Analyze dependency graph and recompute affected data.
8. Restore constitutional Echo projections.
9. Run independent bidirectional/invariant tests.
10. Release only after required approvals and all checks pass.

## Connector boundaries

Connector adapters are transport and evidence boundaries, not truth authorities. Reads are distinct from writes. Provider output is untrusted input. Writes use the existing integration lifecycle, request-bound approval, least privilege, and audit trail. No production deployment, main-branch write, or autonomous privilege escalation is in scope.

## Initial delivery boundary

This branch begins with architecture and contract documentation. Runtime implementation must be introduced in the repository's established core/module boundaries after inspecting existing contracts and test conventions. Do not duplicate existing authorization, evidence, or integration-governance systems.