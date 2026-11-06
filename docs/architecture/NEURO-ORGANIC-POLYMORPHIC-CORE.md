# NEURO-ORGANIC POLYMORPHIC CORE (NOPC)

**Status:** Architecture specification / not yet implemented  
**Parent system:** KRATT PRIME  
**Primary client:** TARK MEES TASKUS  
**Scope:** adaptive human interaction AND adaptive agent operations

## 1. Purpose

The Neuro-Organic Polymorphic Core (NOPC) is a governed adaptation layer. It changes how information is presented and how authorized agents organize their work, based on explicit user preferences, task context and observable system constraints.

NOPC is not a diagnostic engine, mental-health monitor or autonomous authority layer. It must not infer bipolar disorder, neurodivergence, mood, emotional state or health status.

## 2. Two adaptation planes

### A. Human interaction plane

- selectable interaction profiles and custom preferences;
- adjustable information density, pacing, notification frequency and focus mode;
- alternative text, voice and visual presentation;
- user-defined availability and quiet periods;
- transparent explanation of why a presentation preference was applied.

### B. Agent operations plane

- task decomposition and bounded re-planning;
- role assignment based on declared agent capabilities;
- queue prioritization using task urgency, dependencies and explicit user priorities;
- cooperative execution with bounded concurrency and resource budgets;
- memory retrieval scoped to the task and authorization context;
- pause, resume, cancel and escalation controls;
- evidence-backed handoff between agents.

An agent may change its execution strategy only within capabilities and permissions already granted to it. NOPC cannot grant new authority.

## 3. Conceptual submodules

| Submodule | Responsibility | Explicit boundary |
|---|---|---|
| Interaction Adaptation | Presentation, pacing and accessibility preferences | No diagnosis or emotion inference |
| User-Declared State | Optional user-selected work/energy preference | Self-declared, temporary and editable |
| Organic Workflow Morph | Re-plan task order and workflow shape | Preserve task invariants and approvals |
| Agent Polymorphism | Select among authorized execution strategies | No privilege escalation |
| Context & Typed Memory | Retrieve relevant, permitted context | Provenance, scope and retention apply |
| Stability Guard | Detect system overload, loops and resource exhaustion | System telemetry only; not user-health inference |
| Policy Gate | Check every consequential operation | KRATT PRIME policy remains authoritative |
| Evidence Ledger | Record decisions, changes and outcomes | Append-only or tamper-evident implementation required |

## 4. User-declared work modes

The initial model should use neutral, configurable labels:

- LOW_STIMULATION
- STANDARD
- DEEP_FOCUS
- CUSTOM

A user may optionally choose a temporary preference such as “low energy” or “high energy”, but this is a personal setting, not a clinical signal. It must not be inferred or retained as a health profile. Avoid storing the label longer than needed for the selected session unless the user explicitly saves it as a preference.

The word “bipolar” in the originating product idea is treated as an accessibility and flexibility design concern, not as a request to diagnose, classify or monitor anyone. No bipolar-specific clinical feature is in scope.

## 5. Polymorphic workflow contract

Every adaptation request should carry:

- request_id
- actor_id and authenticated principal
- task_id / workflow_id
- declared_mode (optional, user-controlled)
- allowed_capabilities
- policy_context
- resource_budget
- deadline (optional)
- evidence_context

Every proposed plan change should produce:

- prior plan reference and proposed plan;
- reason code and triggering system/task context;
- affected tasks and agents;
- capability and policy validation result;
- user approval requirement, if any;
- audit/evidence reference;
- rollback or recovery strategy.

No adaptation is accepted solely because an agent recommends it.

## 6. Immutable invariants

1. NOPC is subordinate to KRATT PRIME Core and its policy/authorization boundary.
2. It cannot create, widen, transfer or infer permissions.
3. It cannot bypass approval, trusted-clock, evidence, nonce or audit requirements.
4. It cannot change the identity or trust level of an agent.
5. It cannot silently export memory or user data to an external provider.
6. It cannot convert a mock adapter into a live integration.
7. It cannot suppress security alerts or hide failed operations.
8. User-selected modes are reversible and can be disabled.
9. Health-related data is excluded by default; no diagnosis or health prediction.
10. Safety-critical and irreversible actions retain existing approval requirements regardless of mode.

## 7. Memory and privacy

- Store durable preferences only with explicit user action.
- Keep temporary session modes ephemeral by default.
- Attach provenance and purpose to every retained preference.
- Provide inspect, edit, disable and delete workflows.
- Do not derive sensitive traits from usage analytics, voice, text, camera, location or biometric signals.
- Apply data minimization and retention limits to agent context.
- External processing requires an explicit, documented integration and authorization.

## 8. Stability and failure behavior

- If the adaptation service is unavailable, fall back to the last user-selected safe presentation profile or standard mode.
- If agent planning fails validation, retain the last valid plan and pause the affected operation.
- If resource limits are reached, pause or queue work; do not silently increase permissions or budgets.
- If evidence cannot be recorded where required, fail closed for consequential actions.
- If state is ambiguous, ask for user confirmation rather than infer intent.

## 9. Implementation sequence

1. NOPC-0 — Contracts: types, policy boundaries, event schema and threat model.
2. NOPC-1 — User interaction: local preference profiles in TARK MEES TASKUS.
3. NOPC-2 — Workflow planner: deterministic task reordering within fixed constraints.
4. NOPC-3 — Agent orchestration: capability-aware allocation and bounded collaboration.
5. NOPC-4 — Typed memory: task-scoped retrieval and explicit preference lifecycle.
6. NOPC-5 — Evaluation: accessibility testing, adversarial authorization tests, privacy review and measured reliability.

Each phase requires tests and evidence before being described as implemented. This document alone does not implement NOPC.
