# TARK MEES TASKUS — Android & iOS Delivery Brief

**Status:** Planning brief  
**Parent:** KRATT PRIME  
**Client platforms:** Android and iOS  
**Related architecture:** docs/architecture/NEURO-ORGANIC-POLYMORPHIC-CORE.md

## 1. Delivery objective

Deliver one coherent mobile product named **TARK MEES TASKUS** for Android and iOS. Both clients consume the same governed KRATT PRIME API contracts. Platform-specific implementations may differ where required for secure storage, notifications, background execution and accessibility.

## 2. Suggested layered design

1. Presentation: navigation, accessible components, interaction profiles and localized content.
2. Application: session, task, agent, approval and memory workflows.
3. Domain contracts: typed requests/responses and state machines shared across platforms.
4. Security boundary: authentication, secure credential storage, request signing where required and explicit approval UX.
5. Transport/adapters: authenticated API client, offline queue for safe idempotent operations, push notification adapter.
6. KRATT PRIME services: policy, agent orchestration, typed memory, evidence and integration gateways.

The mobile application must never become a source of truth for policy decisions. Server-side KRATT PRIME authorization is authoritative.

## 3. Primary screens

- Welcome / sign-in
- Home / daily overview
- Assistant conversation
- Agent directory and agent detail
- Task board and task detail
- Approval review
- Memory and provenance inspector
- Interaction mode settings
- Connected services
- Security, sessions and audit history

## 4. Platform requirements

### Android
- Android Keystore-backed credential storage.
- Runtime permissions requested just in time.
- Background work constrained by Android lifecycle and battery rules.
- Notification channels with user-configurable sensitivity.
- Deep links validated against an allowlist.

### iOS
- Keychain-backed credential storage.
- Background execution limited to supported system modes.
- User-controlled notification permissions and previews.
- Universal links validated against an allowlist.
- Respect system accessibility, motion and privacy settings.

## 5. Offline and synchronization rules

- Clearly display offline, stale, syncing, connected and failed states.
- Queue only operations designed to be safely retried and idempotent.
- Never queue privileged external writes without a fresh authorization check at execution time.
- Do not cache secrets or sensitive agent context in ordinary application storage.
- Resolve conflicts through explicit versioning and server-side policy; do not silently overwrite.

## 6. Accessibility and personalization

Support text scaling, screen readers, contrast, reduced motion, keyboard navigation, adjustable density and user-selected notification pacing. Profiles such as Rahulik, Tavaline and Süvafookus are convenience presets and remain fully customizable.

No biometric, voice, typing or behavioral analysis is permitted to infer a diagnosis or mood. Any optional voice feature must be separately permissioned and visibly active.

## 7. Security acceptance gates

- Threat model covers lost device, stolen session, malicious deep link, replay, token theft, notification leakage and compromised adapter.
- No privileged secrets embedded in app binaries.
- Server validates identity, scope, policy and freshness for each protected operation.
- Approval details identify action, target, scope and consequence.
- Logout/revocation invalidates server-side sessions.
- Audit records distinguish requested, approved, executed, failed and cancelled states.
- Sensitive data is excluded from analytics and crash logs by default.

## 8. Release gates

- Shared API contract tests pass.
- Android and iOS builds are reproducible.
- Accessibility review completed on both platforms.
- Security and privacy review completed.
- Offline/retry and session-revocation tests pass.
- Store metadata, legal name checks and privacy disclosures reviewed.
- Release is explicitly authorized; this brief does not authorize publication or deployment.

## 9. Non-goals for the first milestone

- Autonomous clinical or psychological assessment.
- Background mood or behavior monitoring.
- Unrestricted agent execution from a phone.
- Automatic production deployment or app-store publication.
- Claims of live Telegram or third-party integrations before verification.
