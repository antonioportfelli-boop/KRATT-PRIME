# 3XTRINITY repository portfolio audit — 2026-11-27

**Purpose:** consolidate verified repository state, distinguish integrated code from candidate branches, and prioritise safe next work.  
**Write boundary:** this report is committed to the KRATT PRIME Wave 12 feature branch only. It does not change any repository default branch, deploy, run migrations or enable provider credentials.

## 1. Executive status

| Repository / source | Verified default branch snapshot | Current assessment | Immediate priority |
|---|---|---|---|
| KRATT PRIME — Antonio fork | `main` `782373cd7760a12141c75655dd890313c30f3021` (2026-11-25) | Strong governed core and evidence/authorization layers; multiple active draft stacks, not integrated | Keep WP-03/WP-04 dependency order; shared-store effect-boundary and tenant isolation |
| KRATT PRIME — Wave 12 candidate | `feature/wave12-bounded-outbox-throughput-2026-11-27` | Bounded outbox worker, tests, security alignment, STEEL remediation and portfolio audit; PR #67 draft | Review + measure on controlled PostgreSQL/provider test harness |
| STEEL — canonical organisation repository | `main` `1da5fd84d9ebb0a796326e3453d052ca73bc7650` (2026-11-11) | Substantial real codebase; separate AI-provider candidate on `feat/kratt-dual-ai-wave444`; no PR open observed | AI provider timeout/stream/write-auth hardening; separate build from migration |
| STEEL — Antonio-account copy | `main`, one README commit, reported repo size 0 | Not the canonical 36 MB source tree; do not treat as the integration source | Keep as pointer or archive; do not build against it |
| FRAME.9 — Antonio fork | `main` `058293438757c6df5eb6d4d20c6562f1d318caca` (2026-11-11) | Application and host/cosmic work exist; main package lock is malformed; app CI only triggers on Forge.-9 | P0 lockfile reconstruction and main CI gate |
| AURA — canonical organisation repository | `main` `22caaeac17bf157cc6354d570f574bff2731e644` (2026-10-04) | Small visualizer/PWA project; last observed main CI success Oct 4; OS/Android remain planned | Refresh dependencies/CI and clarify app scope, only when AURA work resumes |

## 2. KRATT PRIME — integrated foundation versus candidates

### Mainline capabilities observed
Main already contains request-bound approval primitives, trusted evidence verification, fail-closed policy, append-only evidence/execution records, construction protocol, a governed execution bridge, local worker lease/fencing and recovery inspection. These are meaningful foundations, not merely design notes.

### Mainline limits that remain explicit
- The local PrimeStore/worker-lease implementation is single-process and does not provide distributed multi-host mutual exclusion.
- The governed execution bridge is not an external execution fleet; it intentionally reports `dispatch: false` and `externalEffects: false`.
- PostgreSQL outbox/runtime, Fabric transport, provider workers and adapter execution are in separate draft branches. Existence of their code or tests is not integration proof.
- WP-04 process isolation depends on a trusted host supervisor and verifier; the repository does not itself prove platform/container attestation.
- Tenant-bound storage and audit partitioning need to be designed and adversarially tested before multi-tenant operation.

### Existing draft dependency chain
- Wave 2: PR #58 — shared PostgreSQL governed runtime.
- Wave 3: PR #59 — trusted Fabric ingress, signed outbound and outbox.
- WP-03.8 / WP-03.9: PR #60 / #61 — receiver deduplication, durable ACK replay, provider worker security.
- WP-04.1–04.5: PR #62–#66 — contract, provenance, request-bound capability grant, process isolation and proxy-boundary hardening.

All of these were observed as open draft PRs. Preserve their dependency order; do not flatten them into main or describe them as certified production features.

### Wave 12 candidate
PR #67 adds:
- bounded outbox concurrency (default 4, maximum 32), deterministic result order and batch throughput metrics;
- four new outbox tests covering concurrency, retries, lease loss and hostile adapter registries;
- an isolated Node 22 validation workflow;
- security-framework mapping and STEEL AI-provider remediation documentation.

The latest observed Wave 12 push and PR workflows passed. That is candidate-branch CI evidence, not production-load evidence. See PR #67.

## 3. STEEL — canonical source and integration boundary

The organisation repository is the canonical codebase, not the almost-empty Antonio copy. The organisation repository contains a functioning Factory dispatcher/state machine, closed TaskEnvelope/ActionReceipt contract, capability registry and trust-gate components. The current AI provider code is on a feature branch and is not on STEEL main.

### AI-provider findings from `feat/kratt-dual-ai-wave444`
1. **Timeout scope:** timeout is cleared after fetch headers arrive, before JSON or stream body consumption finishes. Slow bodies can exceed the configured deadline.
2. **Streaming:** raw decoder chunks are returned rather than parsed SSE events and normalized text deltas; chunk boundaries are not semantic token boundaries.
3. **Write authority:** the current helper uses caller-supplied booleans. It must not issue a production WRITE grant. KRATT WP-01 must remain the approval authority.
4. **Rate limit:** the in-memory Map is process-local and lacks bounded key cardinality/global coordination.
5. **Configuration:** `baseUrl` is supplied but ignored; endpoint origins are hard-coded. Model and token budgets need explicit allowlists and caps.
6. **Registry and readiness:** duplicate registration can replace a provider, and provider health/circuit-breaker state is not a complete routing gate.
7. **Observability:** the presence of a token-redaction helper does not prove all application logs/traces pass through safe structured redaction.

A specific remediation plan is committed at `docs/integrations/STEEL-AI-PROVIDER-REMEDIATION-2026-2027.md`.

### Separate operational concern
STEEL's current `npm run build` includes `npm run db:migrate`. The migration script skips when `DATABASE_URL` is absent, but applies pending migrations when it is present. This is an intentional deployment coupling in the checked source, yet it means build and schema mutation are not intrinsically separate. For safer CI, preview and rollback, use a build-only command and an explicit, separately approved migration job. Do not execute migrations during this audit.

### Write limitation
The Antonio-linked GitHub integration returned HTTP 403 when creating a new branch in the organisation STEEL repository. No files were changed there. Do not overwrite its existing feature branch as a workaround.

## 4. FRAME.9 — verified P0 repair blocker

The default-branch `package.json` parses, but contains duplicate object keys:
- `build:deploy` appears twice (same command);
- `eslint-plugin-react-refresh`, `globals`, `playwright`, `prettier` and `typescript-eslint` appear twice with different ranges.

The default-branch `package-lock.json` is not valid JSON. Independent parsing of the full 282,077-byte file failed first at line 81 (missing comma), then at line 3,744 (extra closing object structure after the TypeScript ESLint parser dependency). It is not safe to hand-edit only the first syntax error: the full lock must be regenerated from the cleaned manifest and verified by `npm ci`.

The default-branch `.github/workflows/ci.yml` triggers push and pull-request gates only for `Forge.-9`, not `main`. The workflow also repeats checkout/setup-node and build steps. Recent FRAME runs are concentrated on Forge.-9 and Dependabot; a Nov 17 main topology workflow run failed. The open topology PR #47 is separate and does not repair the application manifest/lock or default-branch CI trigger.

### Repair branch created
- Branch: `repair/frame9-lockfile-main-ci-2026-11-27` (from `main`).
- Duplicate package.json keys removed, preserving the effective last parsed values initially.
- Toolchain aligned: Vite 8 + `@vitejs/plugin-react` 6.3; TypeScript 6.0.3 + `typescript-eslint` 8.74. TypeScript 7 was not retained because the available eslint parser peer range excludes TS 7.
- Ajv 8.20 is now explicitly in devDependencies to satisfy `@hookform/resolvers`' optional Ajv 8 peer while npm keeps Ajv 6 for ESLint's older dependency tree.
- package-lock was regenerated by Node 22 / npm 10.9.9 on GitHub Actions and pushed to the repair branch; it was not hand-edited.
- The custom workflow now separates the write-enabled lock regeneration job from read-only PR validation, runs Gitleaks, `npm ci`, manifest/lock consistency, typecheck, lint, auth invariant, tests and build with `DATABASE_URL` empty.
- TypeScript 6's deprecation error for `baseUrl` was fixed by removing `baseUrl`; the `paths` alias remains rooted relative to tsconfig.

### Validation status at report update
- Gitleaks: **passed**.
- Dependency regeneration: completed in the previous run.
- `npm ci` and manifest/lock root maps: **passed** in the previous run.
- Typecheck: the previous run failed only on deprecated `baseUrl`; the fix is committed.
- The current run `46000919999` is still in progress at the lock regeneration step. Do not mark this repair green or open it for merge until the follow-up validation job passes all checks.

No database migrations, production deployment, or main-branch writes were performed.

## 5. AURA — project scope and current freshness

AURA main is a small React/Vite visualizer with Node 22, typecheck and build commands. The checked README describes simulated spectrum modes (no microphone), a demo shell and planned OS/Android surfaces. The last observed main commit and green main CI were both October 4, 2026. No subsequent November main build was observed in the queried run history.

AURA should remain a visualizer/product surface and not be treated as a security control-plane or as proof of native Android/desktop readiness. When resumed, refresh the CI/dependency evidence and define the OS/Android deliverables separately.

## 6. Cross-repository integration contract

KRATT should own the trust decision and durable authorization evidence. STEEL should execute only typed, explicitly permitted operations and return receipts. FRAME.9 can surface host/network intelligence and local operator workflows, but observations must retain source, timestamp, confidence and provenance. AURA remains a separate visualizer.

Required shared fields across adapters and Fabric:
- immutable repository/commit/path/artifact digest;
- event/request/correlation IDs and schema version;
- principal, agent, provider, operation, resource target and exact scopes;
- canonical request digest and short-lived approval evidence reference;
- idempotency key, lease/fencing token and cancellation state;
- outcome, evidence references, trace ID and bounded usage/latency metadata.

Never transfer raw credentials or promote a source's self-asserted `verified` flag into authority.

## 7. Recommended execution order

| Priority | Work | Exit gate |
|---|---|---|
| P0 | FRAME.9 manifest/lock/CI repair | Regenerated lock; `npm ci`; all checks green on PR to main |
| P0 | KRATT distributed effect-boundary guarantees | PostgreSQL race tests for cancellation, revocation, rotation and fencing |
| P0 | Verified adapter process supervisor | OS/container attestation and isolation tests |
| P1 | STEEL OpenAI/xAI runtime repair | bounded SSE, full-body deadlines, model/rate limits, no caller-asserted writes |
| P1 | Shared Fabric contract and receiver/worker reconciliation | signed ACK + dedup/replay tests across both repositories |
| P1 | Supply-chain provenance | SBOM + verified signed SLSA provenance in release CI |
| P2 | OpenTelemetry service dashboards | queue age, p50/p95/p99, saturation, errors, cost, without sensitive labels |
| P2 | AURA refresh | fresh build/test evidence and explicit web/desktop/Android scope |

This report is a source-of-truth snapshot, not a certification. Repository state, workflow status, permissions and standard editions must be refreshed before each release decision.
