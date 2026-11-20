# Wave 1–10 — critical gaps and delivery register

**Snapshot date:** 2026-11-20  
**Working branch:** \`feature/wave1-10-observatory-http-integration-2026-11-20\`  
**Parent:** merged Wave 1–10 alignment PR #40, base branch \`feature/wave10-observatory-hardening-remediation-v1\`  
**Main SHA at inspection:** \`ef3422809bbc54381a9ca3a15904727074ca0b16\`

## 1. Actual source state

The Wave PRs are not one continuous Git ancestry chain. The status below records the real PR bases and heads inspected on GitHub, not a claim that all features have been merged into main.

| Wave | Current evidence | Critical integration gap |
|---|---|---|
| 01 — Core | Core contracts and tests exist on main; PR #1 is historical | Keep core contracts as the shared source of truth; do not copy new policy engines into each module |
| 02 — Trust | PR #3 open; earlier PR #2 closed | Complete the trusted key lifecycle, verifier ownership, replay persistence and independent security review |
| 03 — Fabric / dispatch | PRs #27 and #28 open as sibling drafts from main | Reconcile event envelope, lifecycle gateway, authorization and durable dispatch without duplicate policy logic |
| 04 — Outbox / recovery | PR #30 open as a draft from main; PR #29 superseded/closed | Rebase or reconstruct against the selected Wave 3 head and prove one atomic approval/cancellation/idempotency/intent/outbox/audit boundary |
| 05 — Async trust / STEEL | PR #31 open as a draft from main | Keep STEEL v1 contract as upstream truth; add live receipt verifier and a centrally versioned evidence-claim mapping |
| 06 — Competitive Intelligence | PR #32 open as a draft from main | Bind every price/ranking claim to a verified source, currency, unit, region and time baseline; preserve unknown/incomplete states |
| 07 — Telegram snapshots | PR #33 open as a draft from main | Verify multi-worker lease fencing, replay handling, snapshot immutability and source provenance against a real PostgreSQL integration suite |
| 08 — Staging composition | PRs #34 and #35 open as sibling drafts from main | Reconcile runtime composition and live connector assembly, including migrations, config contracts, consent and preflight |
| 09 — Resilience | A Wave 9 branch exists and its code/runbook is in the Phase 10 candidate | Keep multi-replica rate limiting, schema gates, safe readiness and migrations on the selected cumulative chain; run supervised staging checks |
| 10 — Observatory | PR #36 remains open/draft; PR #38 remains open and unmerged; PR #39 merged into the separate Phase 10 candidate; PR #40 merged into the Wave 10 remediation branch | Reconcile the diverged Phase 10 and remediation candidates. This branch mounts the read API into the staging HTTP server, but does not supply a live identity provider or authorization policy |

PR #37 is WP-10 scale measurement / semantic retrieval work based on a separate worker-lease branch. It is adjacent to Wave 10, not evidence that the Wave 1–10 chain is complete.

## 2. Critical work completed in this continuation

The following source changes have been written to the current feature branch and are covered by tests or the branch quality workflow:

1. **Wave 10 HTTP composition.** The existing Runtime Observatory API is now mounted at \`/observatory/*\` in the Wave 8 staging HTTP server through a dedicated HTTP adapter.
2. **Default-deny boundary.** Without an injected server-owned principal resolver and read authorizer, Observatory reads return 403. POST and other non-GET methods return 405. No caller-provided identity or role header is trusted.
3. **Safe principal snapshot.** The HTTP adapter copies only flat primitive claims and bounded string arrays from own data properties. Accessors, nested objects and malformed arrays are rejected.
4. **HTTP input tests.** Coverage includes unrelated paths, missing resolver, spoofed headers, resolver failure, accessor-backed principals, duplicate query parameters, denied writes and hash-chain field omission.
5. **Wave 5 STEEL boundary hardening.** Task and receipt inputs are recursively copied from own data descriptors before validation. Getter-backed properties, sparse arrays, cycles, symbols, unsafe object keys, excessive depth/size and invisible/bidi objective characters fail closed.
6. **Wave 1–10 evidence gate.** The progression helper now requires an injected evidence verifier. A caller-supplied \`verified: true\` value by itself cannot satisfy a wave's evidence requirements.
7. **Source lineage refresh.** PR #39 and PR #40 are recorded as merged into their respective feature branches; PR #38 is recorded as open and unmerged. The main SHA is pinned in the source snapshot.
8. **STEEL source pin.** The current STEEL Protocol v1 source blob SHAs are recorded in \`packages/kratt-core/contracts/steel-factory-protocol-v1.sources.json\`.

## 3. Remaining critical work, ranked

### P0 — resolve branch divergence and select one canonical chain

- Compare PR #36's current head with PR #38's current head and the two merged hardening increments.
- Reconcile only non-overlapping changes; do not merge the branches blindly or force-update either branch.
- Select one canonical Wave 10 head after all tests pass.
- Continue backwards: select Wave 3's canonical contract/dispatch base, then stack Wave 4, Wave 5, Wave 6, Wave 7, Wave 8 and Wave 9 in that dependency order.
- Preserve all original candidate branches and draft PRs until their content is represented and verified on the canonical chain.

### P0 — complete real authorization for Observatory reads

- Supply a real server-side session/principal resolver to \`createWave8StagingServer\`.
- Supply a read policy to \`authorizeObservatoryRead\`, scoped to the authenticated principal and the requested resource.
- The current defaults intentionally deny all reads. The HTTP adapter must not be changed to trust headers, query parameters or client-supplied roles.
- Add host-specific tests for expired sessions, tenant/scope mismatch, revoked access and authorization backend failure.

### P1 — finish STEEL trust integration

- Reconcile the pinned STEEL Protocol v1 source SHAs with the exact STEEL branch selected for integration.
- Add a shared conformance vector job across KRATT and STEEL.
- Inject a real independently verifiable ActionReceipt attestation/signature verifier.
- Centrally version the evidence-claim mapping. Unknown claims must deny, not be guessed.
- Run the full STEEL → KRATT authorization → durable outbox → receipt verification round trip.

### P1 — reconcile Waves 3 and 4

- Select one Fabric event envelope and one integration lifecycle registry.
- Prove READ and WRITE are separate capabilities, with exact request-bound approval for every write.
- Verify transaction atomicity for approval nonce, cancellation, idempotency, intent, outbox and audit.
- Prove worker leases are fenced, retries are bounded and dead letters are inspectable.
- Run PostgreSQL concurrency and rollback tests against a real temporary database in CI.

### P1 — join Waves 6 and 7 to trusted evidence

- Preserve raw source provenance outside model output.
- Reject parser-supplied timestamps, prior baselines and source identifiers.
- Keep prices comparable only when competitor, SKU, currency, billing unit, region and observation period match.
- A missing baseline remains unknown; never convert it to zero change.
- Bind every snapshot projection to a verified evidence reference and hash-chain sequence.

### P2 — consolidate Wave 8 and Wave 9

- Merge the staging composition and live connector candidates only after migration, schema and configuration contracts are reconciled.
- Keep Telegram webhook setup as a separately approved operator action.
- Use separate migration and runtime database identities.
- Verify PostgreSQL TLS, grants, DNS/TLS, Telegram reachability and source allowlists in a supervised staging environment.
- Never commit credentials or send Telegram message bodies to an external model without explicit, documented consent.

### P2 — finish the functional and visual system

- Mount the protected API with a real server-side authorizer; the UI already calls the read-only endpoints.
- Add module-level evidence, health, unbound, disabled, degraded and denied states from actual runtime records.
- Keep AURA as a separate visualizer; do not claim that its demo spectrum is a live Observatory view.
- Add browser-based accessibility and responsive visual tests for narrow mobile, tablet and desktop layouts.
- Show “not run” and “unbound” distinctly from “success” in every module card.

## 4. Work that still requires an operator or external environment

The following items cannot be truthfully completed from feature-branch code alone:

- provision or rotate production signing keys;
- configure real Telegram webhook secrets or replace an existing webhook;
- create or access real provider credentials and quotas;
- apply migrations to a real staging or production database;
- prove actual PostgreSQL roles, TLS, DNS, reverse proxy and firewall behavior;
- approve data transfer from Telegram to an external model;
- verify a production session provider, identity service or organization policy;
- deploy, publish, merge to main or enable real provider dispatch.

These are explicit verification and approval gates, not missing implementation details that can safely be fabricated in code.

## 5. Required acceptance sequence

A wave is promoted only when its logical prerequisites, tests, typecheck/build, security review and required operator evidence are present on the exact candidate SHA. A green local contract suite is not a production attestation; a merged feature PR is not proof of a production integration.

The current continuation branch remains a draft feature candidate. It does not modify main, configure webhooks, run database migrations, dispatch providers or deploy an application.
