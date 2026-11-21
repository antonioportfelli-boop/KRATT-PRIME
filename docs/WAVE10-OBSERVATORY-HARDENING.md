# Wave 10 — Runtime Observatory hardening

**Repository:** `antonioportfelli-boop/KRATT-PRIME`  
**Base candidate:** draft PR #36, `feature/phase10-runtime-observatory-v1`  
**Hardening branch:** `feature/wave10-observatory-hardening-remediation-v1`  
**Status:** feature-branch implementation; no merge, migration or deployment.

## What this remediation changes

- Connects the observed-operation runner to the actual Telegram competitive-ingestion composition. Every delivery attempt receives its own operation ID and the Telegram update ID remains the correlation key.
- Persists only opaque update/result references and typed lifecycle metadata. The Telegram body, webhook secret, provider response and error text are never written to the observatory event.
- Fails closed before ingestion if the queue or running event cannot be durably appended. If execution occurred but its terminal event could not be stored, the webhook returns an error rather than falsely acknowledging a completed operation.
- Treats a canonical duplicate append as idempotent success, matching the PostgreSQL store contract.
- Validates list filters before storage access and returns HTTP 400 for invalid limits, statuses, module IDs or unknown filters instead of disguising client errors as storage failures.
- Removes internal previous/hash-chain values from the operation-event read API response. Integrity verification remains a boolean/count contract.
- Rejects accessor-backed evidence references before reading nested fields.
- Re-verifies every persisted operation projection field against the append-only event chain, not just the status/event/sequence pointer. A tampered correlation ID, module, capability, timestamps, references or evidence list now fails integrity verification.
- Runs both CI workflows on the hardening branch and on PRs targeting the Phase 10 candidate branch, preventing the previous silent CI gap for stacked draft PRs.

## API contract

- `GET /observatory/operations`: allowed query keys are `limit` (1–200), `module_id` and `status`.
- Invalid filters return `400 QUERY_INVALID`.
- `GET /observatory/operations/{id}/events` returns sequence, event ID and canonical event only; hash-chain internals are not exposed.
- All routes continue to require an injected server-side `authorizeRead`; no unauthenticated route is mounted by this patch.

## Verification

Run `npm run wave10:verify` for all contract tests, application typecheck and build. Both CI workflows now include this hardening branch and PRs targeting `feature/phase10-runtime-observatory-v1`. Run `npm run wave10:observatory:verify` only with an operator-provisioned staging `.env.wave8`; that command is read-only.

The hardening does not claim that AURA consumes the API, that all platform modules emit events, or that production/staging credentials and database grants are configured. Base44's existing KRATT Integration Hub passes `npm run build`; it has no `test` script yet, and the builder status endpoint still reports a stale generic build error, so backend/entity and hosted-function tests remain unverified. The separate Lovable Runtime Observatory UI was updated in commit `8f8a243fd3063d6a9cfd7bc4642553d30327ac00`; its agent reports 30 tests passing and typecheck clean, but the final build/browser check was not rerun after credits were exhausted. Neither project was published.

## Release boundaries

- Keep PR #36 (Phase 10 candidate) and PR #37 (WP-10 scale/semantic retrieval) separate and draft.
- No main-branch writes, PR merges, staging migration, webhook configuration, production deployment, provider dispatch, secret rotation or permission changes.
