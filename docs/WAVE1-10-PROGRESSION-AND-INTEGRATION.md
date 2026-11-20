# KRATT PRIME — Wave 1–10 progression and integration contract

**Working branch:** \`feature/wave1-10-progression-alignment-2026-11-20\`  
**Parent:** \`feature/wave10-observatory-hardening-remediation-v1\`  
**Parent commit:** \`d7e14dda1d0dd50ccec6fbb4179fc088dc609916\`  
**Scope:** source reconciliation, typed progression gates and a separate read-only control desk  
**Release posture:** draft-only; no merge, deploy, production migration, secret write or provider dispatch

## 1. Why this branch exists

The repository contains substantial Wave 1–10 work, but the GitHub metadata shows that many feature candidates were created as siblings from \`main\`, not as one verified cumulative branch chain. Wave 10 itself has a core candidate (PR #36) and two separate hardening drafts (PR #38 and PR #39) which both target the Wave 10 core branch. They are not stacked on each other.

The objective here is not to merge those candidates blindly. This branch introduces a common inventory, dependency order, acceptance evidence contract and a distinct read-only view so the next integration steps can be executed in a reviewable sequence.

## 2. Wave progression

| Wave | Complexity | Primary layer | Main capability | Current source inventory |
|---|---:|---|---|---|
| 01 | 1/10 | Foundation | Contracts, agent scopes, memory ledger, Saga | Core files are present on inspected \`main\`; PR #1 is historical |
| 02 | 2/10 | Trust | Trusted context, evidence verification, request-bound approval | PR #3 open; earlier PR #2 closed |
| 03 | 3/10 | Integration gateway | 3XT Fabric event envelope, integration lifecycle, authorized dispatch | PRs #27 and #28 are sibling drafts |
| 04 | 4/10 | Durability | PostgreSQL transactional outbox, lease fencing, recovery | PR #30 open; PR #29 closed/superseded |
| 05 | 5/10 | Async runtime | Async trusted authorization, MÕTLEMINE, STEEL Factory Protocol v1 adapter | PR #31 open |
| 06 | 6/10 | Evidence intelligence | Competitive Intelligence, temporal pricing and TCO | PR #32 open |
| 07 | 7/10 | Ingestion | Telegram webhook, inbox/replay control, immutable snapshots | PR #33 open |
| 08 | 8/10 | Staging composition | Strict parser, staging server, connector preflight and explicit consent | PRs #34 and #35 are sibling drafts |
| 09 | 9/10 | Resilience | Multi-replica limiter, schema gates, readiness and ordered migrations | Wave 9 branch and content in the Phase 10 candidate |
| 10 | 10/10 | Observability | Operation lifecycle, append-only history, projection integrity and protected read API | PR #36 core; #38 and #39 parallel hardening drafts |

The authoritative machine-readable list and gate logic live in \`packages/kratt-core/src/wave-progression.mjs\`. Its dependencies are logical release dependencies, not a claim that Git commits already form a single ancestry chain.

## 3. Complexity progression

Complexity increases by one controlled layer at a time:

1. **Level 1 — deterministic foundation:** typed data, explicit invariants and pure state transitions.
2. **Level 2 — trusted authority:** server-owned context, independently verified evidence, signed approvals, replay protection and fail-closed behavior.
3. **Level 3 — integration boundary:** canonical Fabric events, plugin lifecycle and strict separation of read from write.
4. **Level 4 — durable execution intent:** database transactions, idempotency, cancellation serialization, outbox and fenced leases.
5. **Level 5 — asynchronous trust composition:** approval claims are consumed atomically with durable intent; STEEL protocol mapping remains contract-driven.
6. **Level 6 — evidence-backed intelligence:** comparable units, explicit temporal baselines, provenance and digest-bound outputs.
7. **Level 7 — trusted ingestion:** authenticated webhook, allowlisted sources, durable inbox and immutable snapshots.
8. **Level 8 — supervised staging:** explicit opt-ins, bounded connectors, strict data consent, schema preflight and operator-run webhook changes.
9. **Level 9 — resilience:** replica-safe shared controls, safe readiness, recovery and reproducible migrations.
10. **Level 10 — observability:** operation events, truthful lifecycle states, chain/projection verification and protected read surfaces.

A higher level does not waive a lower-level control. No wave may be promoted because a UI looks complete or because a branch exists.

## 4. Reconciliation order

### 4.1 Preserve source and branch lineage

- Keep \`main\` unchanged.
- Keep PRs #36–#39 in draft state until their overlap and CI are independently reconciled.
- Compare PR #27 with #28 before choosing a Wave 3 canonical head.
- Compare PR #30 with the selected Wave 3 result; verify the exact transaction boundaries in source rather than relying on PR prose.
- Verify that Wave 5 uses the real \`factory/protocol/types.ts\` and \`factory/protocol/protocol.schema.json\` from STEEL; do not maintain a competing schema.
- Reconcile Wave 8 PRs #34 and #35 before using Wave 9 migration/readiness assumptions.
- Treat Wave 10 PR #38 as the current hardening parent for this branch. PR #39 is a parallel hardening candidate and must be diff-reviewed; do not silently combine it.

### 4.2 Promotion gates

A wave can be marked complete only when all of the following have inspectable references:

- its declared dependencies have passed their gates;
- contract and negative-path tests pass on the exact candidate head;
- typecheck and production build pass where applicable;
- a security review covers the new trust boundary;
- interface states match the real capability state (bound, partial, mock, unbound or disabled);
- the required integration evidence is recorded;
- staging-only work has an operator attestation from the real staging environment.

The \`evaluateWaveGate\` helper is a local progression check. It is not an authorization system, a cryptographic evidence verifier or a deployment permission. Production readiness is deliberately not modeled as an automatic wave state.

## 5. Functional and visual contract

AURA remains a separate lab visualizer. The Runtime Observatory is a KRATT control-plane capability, and its UI must be a separate surface. This branch adds \`programs/web/kratt-control-desk/\` rather than changing AURA's root \`src/App.tsx\`.

The control desk uses the existing Industrial Night visual grammar:

- matte graphite surfaces and restrained grid;
- cool cyan for active/focused/connected states;
- amber for pending review or degraded states;
- red only for critical faults or denied actions;
- monospaced text for identifiers, timestamps and telemetry;
- semantic labels accompanying every status color;
- responsive equal-weight wave cards, keyboard navigation and reduced-motion support.

The dashboard's wave inventory is local, deterministic metadata. Runtime operations, module summaries and integrity are fetched only from same-origin \`GET /observatory/...\` endpoints. It sends no writes, does not accept credentials, and shows an explicit unbound/denied/degraded state when the protected API is absent or refuses access. It never fabricates operations or interprets a mocked adapter as connected.

## 6. API/UI alignment

The page consumes these existing protected read routes:

- \`GET /observatory/operations?limit=20\`
- \`GET /observatory/modules\`
- \`GET /observatory/integrity\`

The host must inject a real server-side \`authorizeRead\` implementation before exposing the API. A 403 response is rendered as denied; it is not bypassed. A 404 is rendered as unbound. A 503 is rendered as degraded. Hash-chain internals, raw Telegram bodies, webhook secrets and error payloads are never requested or displayed.

## 7. Commands and verification

From the repository root on Node 22:

\`\`\`sh
node --test packages/kratt-core/test/wave-progression.test.mjs
npm test
npm run typecheck
npm run build
\`\`\`

To preview the separate desk with the repository Vite server:

\`\`\`sh
npm run dev -- --host 127.0.0.1
\`\`\`

Then open \`/programs/web/kratt-control-desk/\` on that local server. The Observatory panel will stay unbound until a same-origin host mounts the protected read API.

The page is not included in the AURA deployment surface and this branch does not deploy it.

## 8. Explicit non-claims

This branch does not certify that all ten waves have been merged, that any real staging service is currently connected, that a Telegram webhook is active, or that a live database migration has been run. Recorded PR descriptions and previous CI claims are inventory references; they are not substitutes for rerunning checks against the final reconciled head.

No production dispatch, deployment, key provisioning, secret rotation, permission change, production migration or write to \`main\` is part of this work.


## 9. Branch quality workflow

The isolated branch workflow \`.github/workflows/wave-progression.yml\` runs on every push to this progression branch. It executes, in order:

1. Node 22 locked dependency installation;
2. the dedicated Wave Registry and gate tests;
3. the complete KRATT Core + orchestrator contract test suite;
4. the existing application typecheck;
5. the existing application production build.

The workflow is branch-scoped and read-only. Its presence does not change the repository's default branch or release settings. A green result must be confirmed from the actual Actions run on the final branch head; the existence of the YAML file is not evidence that the workflow passed.
