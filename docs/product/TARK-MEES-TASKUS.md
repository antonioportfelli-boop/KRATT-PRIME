# TARK MEES TASKUS — Mobile Product Definition

**Status:** Product specification / proposed direction  
**Platforms:** Android and iOS  
**System foundation:** KRATT PRIME  
**Ecosystem:** 3XTRINITY  
**Working product name:** TARK MEES TASKUS

## 1. Product identity

TARK MEES TASKUS is the human-facing mobile application for the KRATT PRIME governed AI system. The name is intentionally Estonian, friendly and memorable. Present it consistently in the mobile launcher, onboarding, navigation and product documentation.

- Display name: **TARK MEES TASKUS**
- Internal application identifier: provisional; choose platform-compliant reverse-domain identifiers only after confirming the organization’s domain and store strategy.
- Platforms: Android and iOS.
- Primary experience: personal AI assistant, agent workspace and secure mobile control surface.
- KRATT PRIME remains the governed control plane; the mobile app is a client, not a second policy authority.

The product name is a working brand decision, not a claim that trademark, company-name, domain or app-store availability has been legally cleared. Complete those checks before public release.

## 2. Product principles

1. Human control: users initiate or approve consequential actions.
2. Honest capability states: distinguish local, simulated, connected, pending and completed operations.
3. Local-first where feasible: keep sensitive interaction context on-device when practical; explain required remote processing.
4. Least privilege: mobile permissions and agent capabilities are narrowly scoped.
5. Accessible adaptation: offer user-selected interaction modes, readable density, reduced motion and alternative input/output.
6. Recoverability: preserve drafts, show operation state and provide cancellation or rollback where technically possible.
7. Evidence: important actions expose provenance, timestamps, actor and result.

## 3. Main application areas

- **Vestlus:** text and voice interaction, with explicit microphone permission and recording controls.
- **Agendid:** agent directory, role, capability, status and delegated task visibility.
- **Töölaud:** tasks, queues, approvals and recent activity.
- **Mälu:** inspectable memory entries, provenance, retention and user controls.
- **Režiimid:** user-selected interaction and workload preferences.
- **Turvakeskus:** permissions, connected services, session controls and audit history.
- **Ühendused:** status of Telegram and other adapters; disconnected or mocked states must never appear live.

## 4. First release boundary

The first mobile milestone should deliver a secure shell and a narrow vertical slice:

- onboarding and local profile preferences;
- authenticated connection to a KRATT PRIME API boundary;
- read-only agent/task status;
- explicit approval inbox for supported actions;
- user-controlled interaction modes;
- audit/evidence display;
- graceful offline and disconnected states.

Do not imply that Telegram, cloud sync, push notifications, voice, agent execution or local model inference are operational until each integration is implemented and independently verified.

## 5. Accessibility and adaptive interaction

Provide selectable profiles rather than inferred diagnoses:

- **Rahulik:** reduced visual density, fewer simultaneous prompts and calmer notifications.
- **Tavaline:** balanced information density and default interaction.
- **Süvafookus:** focused task view, reduced interruptions and explicit session boundaries.
- **Kohandatud:** user-defined font size, contrast, motion, sound, notification and layout preferences.

These are presentation/workflow preferences, not clinical categories. Users can change or disable them at any time. The application must not infer a user's mood, diagnosis, energy level or health status from typing, voice, usage patterns or sensor data.

## 6. Mobile security requirements

- Store credentials only in platform-secure storage (Android Keystore / iOS Keychain through a reviewed implementation).
- Never embed provider secrets or privileged KRATT keys in the app bundle.
- Use short-lived, scoped credentials and server-side authorization.
- Require explicit confirmation for external writes, account changes and irreversible operations.
- Minimize notification content; sensitive details are hidden by default.
- Provide session revocation and connected-device visibility.
- Treat screenshots, logs, crash reports and analytics as potential data-exfiltration surfaces.
- Do not request accessibility, contacts, location, microphone or background permissions unless a documented feature requires them.

## 7. Acceptance criteria

- The name is consistently documented as TARK MEES TASKUS.
- KRATT PRIME is identified as policy and orchestration authority.
- Android and iOS are both in target scope.
- Every capability has an explicit implementation state.
- User-selected adaptation is supported without diagnosis or behavioral inference.
- No production deployment, store submission or public release is implied by this specification.
