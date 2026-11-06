# GitHub Copilot Execution Directive — TARK MEES TASKUS + NOPC

> Paste this entire directive into GitHub Copilot Chat in Agent mode while the repository is checked out on branch `feature/tark-mees-taskus-neuro-organic-core-2026-11-06`. Work incrementally, inspect before editing, and keep every change reviewable.

## 0. Mission

Implement the next verified engineering increment for **TARK MEES TASKUS**, the Android/iOS client of **KRATT PRIME**, and **NEURO-ORGANIC POLYMORPHIC CORE (NOPC)**, the subordinate adaptation layer.

This is an implementation task, not a documentation-only exercise. Build working, tested code in small vertical slices. Do not generate a giant uncompiled scaffold. Prefer a small number of cohesive modules with strict types, deterministic behavior, tests and evidence.

## 1. Non-negotiable repository and safety rules

- Confirm current repository, branch, HEAD, working tree and remote before edits.
- Required branch: `feature/tark-mees-taskus-neuro-organic-core-2026-11-06`.
- Never switch to, commit to, reset, rebase, force-push or modify `main`.
- Preserve all user changes and untracked files. Never use destructive cleanup.
- Do not merge PRs #7, #8, #9 or #10. Keep PR #10 Draft.
- Do not create a new repository or duplicate the app.
- Do not deploy, publish, submit to app stores, expose a public preview, provision/rotate secrets, alter account roles or connect real external services.
- Never paste tokens, private keys, credentials or personal data into code, logs, tests or reports.
- Do not claim tests/builds/CI passed unless the command actually ran and its output was inspected.
- Do not represent mocks, stubs, local-only prototypes or planned adapters as live integrations.
- If branch or repository differs from the expected target, stop and report; do not guess.
- If a required external permission or secret is missing, build a safe interface and document the blocker; never invent credentials.

## 2. Source-of-truth discovery — do this first

Inspect, then summarize in a short working note:
1. `git status --short --branch`, `git rev-parse HEAD`, `git remote -v`.
2. Root `package.json`, lockfile, `tsconfig*`, Vite config, test config and existing CI workflows.
3. Full tree under `src/`, `packages/kratt-core/`, `programs/`, `apps/`, `tests/`, `.github/`.
4. Existing UI framework, routing, design tokens, state management, API client, auth/session model and error boundaries.
5. Existing Android/iOS projects and native tooling, if any.
6. Existing KRATT Core contracts, policy evaluator, trusted runtime, memory ledger, agent registry, saga and evidence modules.
7. Current tests and baseline failures.

Important known fact to verify: root README and root package manifest currently identify the root app as AURA / `trinitywayve-aura`. Do not rename or repurpose that application. KRATT Core source exists under `packages/kratt-core/src/`; use it as the governed core boundary. No mobile package was confirmed at the last audit. Do not assume Capacitor, Expo, React Native or native shells exist.

Deliver a source-of-truth note before making architecture changes. Separate confirmed facts from assumptions.

## 3. Target architecture — preserve vertical boundaries

```text
3XTRINITY ECOSYSTEM
└── KRATT PRIME — governed control plane
    ├── Core Contracts
    ├── Policy & Authorization (authoritative; immutable from NOPC)
    ├── Trusted Runtime / Clock / Nonce / Approval
    ├── Evidence & Provenance
    ├── Typed Memory
    ├── Agent Registry & Orchestrator
    ├── NOPC — subordinate adaptation/proposal layer
    │   ├── Interaction Preferences
    │   ├── User-Declared Work Modes
    │   ├── Workflow Planner
    │   ├── Capability-Aware Agent Scheduler
    │   ├── Stability / Resource Guard
    │   └── Audit Events
    ├── API / Platform Adapter Contracts
    │   ├── TARK MEES TASKUS Mobile API
    │   ├── Telegram Adapter (only if existing contracts support it)
    │   └── Future adapters
    └── Clients
        └── TARK MEES TASKUS
            ├── Shared product/domain contracts
            ├── Android client
            └── iOS client
```

**Authority direction:** client → authenticated API → KRATT policy/runtime → authorized service/adapter. NOPC can recommend a plan or presentation setting only. It is not a policy engine and cannot authorize or execute protected work.

## 4. Existing NOPC increment — inspect and harden

Files already added on this branch:
- `packages/kratt-core/src/nopc.mjs`
- `packages/kratt-core/test/nopc.test.mjs`

Review them line by line before extending. Validate:
- preference inputs are allowlisted and bounded;
- modes are neutral user-selected settings, never inferred diagnoses;
- planner validates IDs, dependencies, duplicate IDs, capability lists and resource limits;
- dependency ordering is deterministic;
- cycles and missing capabilities fail closed;
- concurrency limits do not cause infinite loops or duplicate blocked records;
- output is explicitly `PROPOSAL_ONLY`, `executionStarted:false`;
- no authorization, privilege mutation, external I/O, timers, hidden global state or direct execution exists.

Add tests for: concurrency cap, multiple ready tasks, completed dependencies, disabled agents, invalid/oversized inputs, deterministic tie-breaking, duplicate dependency IDs if relevant, frozen/immutable output, dependency cycles, and no privilege escalation. Fix defects before adding features.

## 5. NOPC contracts to implement next

Use plain JavaScript ESM consistent with the existing KRATT Core source unless repository conventions show otherwise. Add JSDoc types or TypeScript only if the package architecture supports them. Avoid adding dependencies for simple deterministic logic.

Recommended module split (adapt to actual existing conventions; do not duplicate):
- `nopc/preferences.mjs`: validation/normalization of user-selected preferences.
- `nopc/planner.mjs`: deterministic task DAG validation and ordering.
- `nopc/scheduler.mjs`: bounded capability-hint assignment; no authorization.
- `nopc/stability.mjs`: system resource/concurrency guards only.
- `nopc/events.mjs`: typed, redacted proposal events.
- `nopc/index.mjs`: narrow public exports.
If existing `nopc.mjs` is better, keep it and do not split gratuitously.

Define explicit versioned schemas. Reject unknown keys where contracts are security-sensitive. Bound all arrays, strings, numeric ranges and concurrency. Avoid prototype pollution; accept plain objects only. Do not trust agent-provided authority claims.

### Interaction mode contract
Allowed defaults:
- `LOW_STIMULATION`
- `STANDARD`
- `DEEP_FOCUS`
- `CUSTOM`

Preferences may include density, reduced motion, text scale, notification pacing and quiet hours only if the UI can enforce them. Store only what the user explicitly selects. Session preferences are ephemeral by default. Durable preferences require an explicit save action and lifecycle controls.

Do not add a “bipolar mode”, diagnosis field, health profile, emotion detector, mood predictor, biometric inference or behavioral classification. The originating wording is an accessibility/flexibility design requirement, not permission to process health data.

### Workflow planning contract
- Validate DAG and reject cycles.
- Preserve dependency order.
- Use explicit user priorities and task metadata only.
- Do not silently rewrite task goals or acceptance criteria.
- Every plan is a proposal with a stable ID, input digest, version and reason codes.
- Require policy evaluation before any task can execute.
- Any external write, privileged action or irreversible operation retains existing explicit approval requirements.
- If plan validation, trusted time, evidence or required policy context is unavailable, block or pause safely.

### Agent scheduling contract
- Use declared capabilities only as scheduling hints.
- Distinguish capability labels from authorization scopes.
- Never add scopes, grant tools, elevate agent roles or change trust levels.
- Respect per-agent and global concurrency limits.
- Deterministic tie-breaks; bounded planning; no unbounded retries.
- Unassigned tasks must carry explicit reason codes.
- Agent assignment is not execution.

### Stability guard
- Protect against queue explosion, runaway loops, repeated retries and resource exhaustion.
- Use deterministic counters/budgets passed as arguments; do not add hidden timers or background loops.
- On budget exhaustion, pause/queue and emit a reason.
- Never infer user health from system load.

## 6. TARK MEES TASKUS mobile app — implementation discovery gate

First identify whether the repository already contains a mobile client or native shell. Do not choose a framework by fashion.

Decision:
- If a maintained React web client is intended to become mobile, evaluate Capacitor against the actual codebase and plugin needs.
- If the app is a true native-first experience, evaluate React Native/Expo against current dependencies and native requirements.
- If native projects already exist, extend them rather than create duplicates.
- Record a brief decision with trade-offs, native plugin requirements, build commands and rollback path.
- Do not add Capacitor/Expo dependencies until this discovery and decision are complete.

Minimum first usable mobile vertical slice:
1. App shell branded **TARK MEES TASKUS**.
2. Welcome / sign-in screen wired only to an existing authenticated API contract; otherwise provide a clearly labeled local demo state.
3. Home screen with explicit connection status (offline / disconnected / connected / error).
4. Assistant screen using an existing API abstraction or typed mock fixture; never fake a live backend.
5. Agent/task read-only view.
6. User-controlled interaction settings.
7. Security/session view with honest placeholder states where backend APIs are not available.
8. Error, loading, empty and offline states.
9. Accessible text scaling, screen-reader labels, reduced motion and adequate contrast.
10. Tests for navigation, preference persistence policy, offline state and API error handling.

Do not implement real authentication by inventing an auth provider. Do not put secrets in client code. Never persist access tokens in localStorage or ordinary preferences. Use Android Keystore / iOS Keychain through reviewed platform APIs when a native secure-storage implementation is actually added.

## 7. Mobile domain contracts

Define typed API DTOs for:
- `SessionStatus`
- `AgentSummary`
- `TaskSummary`
- `ApprovalRequest`
- `InteractionPreferences`
- `ConnectionStatus`
- `AuditEventSummary`

Rules:
- Responses are untrusted input and must be validated at the boundary.
- Include schema version and correlation/request ID.
- Avoid copying entire memory records or sensitive prompts into UI state.
- Keep approval screens explicit: actor, action, target, scope, consequence, evidence and expiry.
- Do not offer an approve button unless a real server-side approval endpoint exists.
- Never show “connected” based solely on local mock data.

## 8. UI/UX and brand system

Visible app name: **TARK MEES TASKUS**. KRATT PRIME remains the underlying system, not a competing launcher name.

Build a calm, legible, high-quality mobile interface:
- simple hierarchy and low cognitive load;
- compact/comfortable/spacious density;
- light/dark theme respecting system preference;
- user-controlled reduced motion;
- large touch targets;
- clear status language;
- no excessive gradients, animation or notification noise;
- Estonian as initial primary locale, with localization-ready message keys;
- do not hardcode strings throughout components.

Suggested navigation: Avaleht / Vestlus / Agendid / Töölaud / Seaded. Keep security and approvals easy to reach. Do not add screens without functional purpose.

## 9. Security and privacy gates

- KRATT Core remains the only authorization authority.
- Every protected operation must use existing policy/runtime APIs.
- No client-side authorization decision is trusted by the server.
- No provider secrets in the mobile bundle.
- No sensitive prompt, memory, health or credential data in analytics/crash logs.
- No mood/diagnosis inference from text, voice, typing, camera, location, usage or biometrics.
- No external AI provider data transfer unless an existing authorized integration explicitly supports it.
- Use least-privilege platform permissions; request just in time.
- Deep links must be allowlisted and validated.
- Offline retries only for safe idempotent operations; reauthorize on reconnect.
- Audit requested/approved/executed/failed/cancelled states distinctly.
- If evidence/audit recording is mandatory and unavailable, fail closed.

## 10. Testing strategy — execute, do not merely configure

Run the existing baseline first and capture failures. Then:
- Node unit tests for NOPC.
- Contract tests for all new DTOs.
- Property/boundary tests for input validation and bounded planning.
- Authorization regression tests proving NOPC cannot grant authority.
- UI component and navigation tests using existing test stack.
- Mobile platform build/typecheck only if native project/toolchain is present.
- Accessibility checks and manual screen-reader/reduced-motion checklist.
- Offline/disconnect/retry tests.
- Full repository test and build commands.

Never weaken or delete a test to obtain a green result. If baseline fails, isolate pre-existing failures from new failures. Report exact command, exit code and concise output summary.

## 11. Implementation order — stop after each verified slice

**Slice A — NOPC hardening**
- Review current NOPC module and tests.
- Fix edge cases.
- Add deterministic DAG/planner/scheduler coverage.
- Run targeted Node tests and root test script.

**Slice B — Mobile architecture decision**
- Inspect existing app and native projects.
- Record framework decision; no dependency until justified.
- Define API DTOs and client boundary.

**Slice C — Mobile shell**
- Build branded shell and navigation in the selected existing architecture.
- Add accessible interaction settings and explicit connection states.
- Keep all unavailable backend functions visibly unavailable/demo.

**Slice D — Read-only vertical slice**
- Connect only to verified existing API endpoints.
- Render agents/tasks and evidence summaries.
- Add loading/error/offline states.

**Slice E — Approvals and agent controls**
- Only if server-side endpoints and authorization contracts exist.
- Show exact action/target/scope/evidence.
- No execution without policy + approval.

**Slice F — Native packaging**
- Reproducible Android and iOS builds.
- Secure storage, deep links, notification privacy and permission review.
- No store upload or publication.

After each slice: format → lint → typecheck → targeted tests → full tests → build where supported → inspect diff → commit. Keep commits small and descriptive.

## 12. Git workflow and delivery

- Work only on the specified feature branch.
- Never push to main.
- Do not merge.
- Keep PR #10 Draft.
- Commit completed slices with conventional messages.
- Before each commit inspect `git diff --check`, `git diff --stat`, `git diff`, and `git status`.
- Preserve unrelated modifications.
- If GitHub Actions billing or runner access blocks CI, report the blocker and provide local command evidence; do not fabricate CI success.

## 13. Definition of done

A slice is done only when:
- source code exists and is integrated into the real project structure;
- tests cover success, failure, boundaries and security invariants;
- all relevant commands were executed and results captured;
- no existing behavior was silently removed;
- docs describe actual behavior, not aspiration;
- implementation, mock and unavailable states are explicit;
- diff is reviewable and confined to the feature branch;
- PR #10 remains Draft and main remains untouched.

## 14. Final report format

Return a compact evidence table:
| Area | Files | Implementation state | Tests/build evidence | Blockers |
|---|---|---|---|---|

Then list:
- commits and changed files;
- exact test/build commands and exit codes;
- known failures and whether pre-existing;
- security/privacy review results;
- what remains unimplemented;
- confirmation that main was not changed and no deployment/publication occurred.

**Execution rule:** Start now with Section 2 discovery. Do not ask for approval for safe, reversible changes inside this branch. Stop and ask only if the next action would cross a stated safety boundary or requires an unavailable external authorization.
