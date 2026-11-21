# KRATT PRIME / 3XTRINITY — Governed Build Roadmap
Date: 2026-11-05
Status: DESIGN SPECIFICATION — NOT IMPLEMENTED

## Non-negotiable change boundaries
- Never modify `main` directly.
- Never deploy or publish without a separate explicit authorization.
- Preserve AURA, STEEL, FRAME.9, CERBERUS, GOLIATH OS, and PANDORA as distinct products/modules with explicit contracts.
- A repository name, branch name, configured workflow, mock screen, or adapter interface is not proof of a live integration.
- Every completion claim must cite a changed path, commit, passing test, CI run, artifact digest, or verified external action.
- No secret values in commits, reports, screenshots, or logs.

## Workstream branches (create only in the verified canonical repository)
- `work/kratt-core-hardening` — core behavior, policy, schemas, regression tests.
- `work/runtime-observatory` — evidence-backed telemetry, event timeline, module health.
- `work/assistant-everywhere` — global assistant shell, typed adapter status, permission-gated actions.
- `work/industrial-night-ui` — responsive navigation, design tokens, module workspaces, accessibility.
- `work/native-desktop` — local desktop runtime, host capability adapters, packaging.
- `work/native-android` — Android native runtime, lifecycle, local storage, background work limits.
- `work/ci-quality-gates` — blocking quality/test/typecheck/build pipeline.

These branch names are a plan, not evidence that branches have been created.

## Runtime Observatory
Every displayed value must be derived from an actual source:
- operation ID and correlation ID
- module / adapter ID and declared capability
- status: queued, running, succeeded, failed, cancelled, timed_out, not_run
- started/finished timestamps and duration
- input/output references with sensitive fields redacted
- evidence references: logs, test run, artifact, commit, trace
- environment and runtime version
- resource measurements only when sampled from the host/runtime

Display `MOCK`, `CONTRACT_ONLY`, `UNBOUND`, `DISABLED`, and `NOT_RUN` as distinct states. Never synthesize running events to fill a dashboard.

## Assistant everywhere
- Persistent launcher across application routes.
- Keyboard and touch accessible; focus trap only while modal.
- Context scope visible to the user (current module, selected evidence).
- Typed capability state: `bound`, `partial`, `mock`, `unbound`, `disabled`.
- No action execution unless a server-side policy decision and explicit user grant authorize it.
- Clear offline / disconnected / permission-denied / error states.
- Conversation and operation reports have provenance and retention controls.

## Learning and 1.5x proposals
A 1.5x improvement is a hypothesis, not a guaranteed result.
Each proposal must contain:
- baseline metric and measurement window
- proposed change and expected metric
- confidence and known uncertainty
- cost/risk estimate
- acceptance test and rollback plan
- required human approval
- measured post-change result

The agent may draft and test a proposal in an isolated branch or sandbox. It must not recursively self-modify or self-authorize privileged actions.

## Industrial-night design direction
Visual inputs: user-supplied Paldiski night photography, industrial chimney silhouettes, red aviation warning lights, cold cyan/blue light lines, sodium-vapor street lighting, wet reflections, analog grain, brutalist geometry.

Design tokens (initial proposal):
- base: near-black charcoal
- panels: graphite / smoked glass with restrained translucency
- primary signal: cold cyan
- secondary signal: sodium amber
- critical warning: restrained red
- typography: high-legibility neutral sans; compact mono for telemetry
- motion: short, purposeful transitions; respect reduced-motion
- texture: low-opacity grain and thin signal-line motifs, never behind dense body text

Avoid excessive glow, low-contrast grey-on-black, persistent flashing, ornamental charts, and large hero graphics that consume workspace.

## Responsive behavior
- Mobile-first layout with content-driven breakpoints and container queries.
- Navigation collapses to a clear bottom/tab or drawer model on narrow screens.
- Module workspace actions remain reachable without horizontal scrolling.
- Capability detection is progressive enhancement; do not infer GPU/RAM from unsupported APIs.
- Adapt chart density, animation, and concurrency based on measured support and user preference.

## Desktop and Android separation
Desktop:
- local service/core process separated from UI
- OS-native file access only with explicit user grants
- local database, secure credential store, signed update path
- CPU/GPU acceleration only through detected and tested adapters
- Windows and Linux packaging independently tested

Android:
- native application lifecycle and permissions
- app-private local storage and encrypted secrets
- bounded background work using Android-supported scheduling
- offline queue and idempotent sync
- ARM64 builds and install/test evidence

A webview wrapper alone must not be described as a standalone OS runtime.

## Acceptance gates
1. Correct source repository and immutable baseline SHA.
2. Blocking CI: lint, typecheck, core tests, full tests, build.
3. Security: secret scan, dependency review, permission boundaries.
4. Runtime: real events and truthful status mapping.
5. UI: keyboard, touch, responsive, reduced-motion, empty/error states.
6. Native: signed/verified artifacts with checksums and install evidence.
7. Release: explicit human approval and rollback plan.
