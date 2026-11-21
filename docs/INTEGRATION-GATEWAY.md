# KRATT Integration Gateway v1

## Purpose

Provide a pure, deterministic boundary for registering an integration, moving it through a verified lifecycle, and deciding whether one precisely scoped operation may proceed. The module performs no network calls, does not store credentials, does not invoke providers, and does not persist approvals.

## Lifecycle

`DISCOVERED → CONNECTED_UNVERIFIED → VERIFIED_READ_ONLY → WRITE_PENDING_APPROVAL → WRITE_ENABLED`

Any active state may move to `DISABLED` or `ERROR` where the transition table permits. `DISABLED` is terminal. `ERROR` may only recover to `CONNECTED_UNVERIFIED` or move to `DISABLED`.

The state is not a health check. `VERIFIED_READ_ONLY` must only be assigned by a trusted verifier after a real provider health check and source retrieval. A UI label or a configured URL is not verification evidence.

## Operation gate

`authorizeIntegrationOperation({ integration, request, approval, now })` returns a structured allow/deny decision.

- Read requests require a verified integration lifecycle state and an explicit read operation in the record's allowlist.
- Write requests require `WRITE_ENABLED`, an explicit write operation in the allowlist, and an approved request-bound artifact.
- The approval must match the integration ID, request ID, principal, operation, scope, and SHA-256 digest of the exact arguments.
- Expired, mismatched, malformed, absent, or untrusted inputs fail closed.
- A trusted clock value is supplied by the caller. The module does not read the host clock.

## Separation of duties

This module is a policy helper, not an authentication, signature-verification, durable nonce store, or audit ledger. The server composition root must authenticate the principal, verify the approval's provenance and signature, enforce replay protection transactionally, and append an immutable audit event before dispatching a provider operation. The adapter must independently constrain the provider credential to the same scope.

## Base44 / Lovable / Asana mapping

- Base44 Integration entity: source inventory and read-only UI; connector connectivity remains separate from ChatGPT connector status.
- Lovable `src/lib/platform`: retain its existing typed fail-closed RBAC and adapter interfaces; do not mark a beacon live before a real server-side adapter reports verified evidence.
- Asana: track code, tests, provider health proof, and the explicit handoff blockers.
- GitHub: changes remain on `feature/agentops-trust-control-plane-v1` and in draft PR #27 until CI and independent review succeed.

No production write, merge, deploy, provider credential, or secret is enabled by this contract.
