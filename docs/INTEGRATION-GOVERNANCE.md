# KRATT PRIME — Integration Governance

Status: DESIGN BASELINE / IMPLEMENTATION IN PROGRESS

## Governing boundary

KRATT PRIME is the central governance and integration layer for the 3XTRINITY ecosystem. Within this KRATT-PRIME repository, existing AURA, STEEL, FRAME.9, GOLIATH OS, CERBERUS and Trinity Edge / EdgeFlow code may be inspected, modified and extended as part of the unified KRATT PRIME development effort. Their separate repositories remain independent project histories and are not automatically modified by changes here.

The `main` branch is not a development target. Work is performed on scoped feature branches and integrated through reviewed pull requests. Production deployment, public release, credential changes and account-permission changes are denied by default.

## Integration lifecycle

Each integration must be represented as a typed record with:
- stable integration ID and provider name;
- provider/account identity (never a secret);
- capability set split into read and write scopes;
- allowed resource/target scope;
- connection verification timestamp and evidence reference;
- credential reference identifier only (never credential contents);
- lifecycle state: `DISCOVERED`, `CONNECTED_UNVERIFIED`, `VERIFIED_READ_ONLY`, `WRITE_PENDING_APPROVAL`, `WRITE_ENABLED`, `DISABLED`, `ERROR`;
- last successful verification and last error code.

A connector being present in the tool catalogue is not proof that the user's account is connected or that a requested scope is granted.

## Authorization invariants

1. The authorization plane is deterministic and outside model-generated plans.
2. Missing, malformed, stale or contradictory trusted context returns deny/block.
3. Request-supplied authority claims never grant authority.
4. Effective scope is the intersection of principal, agent, connector, resource and task scopes.
5. Read scopes never imply write scopes.
6. Every external write requires a request-bound approval artifact naming provider, operation, target and expiry.
7. Approval for one operation cannot authorize a different target, operation, provider or later request.
8. Secrets are resolved only by the server-side credential broker and are never included in records, logs, prompts or client payloads.
9. Every allow/deny decision emits a redacted provenance event.
10. Kill switch and integration disablement override all grants.

## Adapter contract

Adapters expose typed operations, not arbitrary URL fetches or free-form tool execution. Every operation declares:
- operation ID and schema version;
- required scopes;
- target constraints;
- idempotency behavior;
- timeout and budget;
- side-effect classification;
- evidence output schema;
- cancellation and recovery semantics.

Default side-effect class is `EXTERNAL_WRITE`, therefore denied absent exact approval.

## Evidence states

- `OBSERVED`: obtained from a live connector response.
- `INFERRED`: reasoned from other evidence; not direct verification.
- `CONFIGURED`: a workflow or setting exists but has not necessarily run.
- `EXECUTED`: operation ran and returned a result.
- `VERIFIED`: result independently checked against acceptance criteria.
- `BLOCKED`: attempted verification was unavailable or denied.

## Current connector inventory (2026-11-01)

| Provider | Observed state | Scope / limitation |
|---|---|---|
| GitHub | Connected | KRATT-PRIME repository; branch-scoped development only |
| Asana | Connected | Read-only project/task audit performed |
| TinyFish | Tool available | Search/fetch tools available; no Agent API credential or run integration verified |
| Base44 | Connected | KRATT Integration Hub app listed; no source write performed |
| WPVibe | Account connected, no sites registered | No WordPress site connection to audit |
| Consensus | Search tool available | Research only; not an execution adapter |
| Parallel Search | Search/fetch tool available | Research only |
| Exa | Search/fetch tool available | Search/fetch tools available |
| Higgsfield | Account identity verified | No KRATT runtime adapter implemented or exercised |

This inventory describes connector observations, not production readiness.

## Acceptance tests required before write enablement

- no trusted context => BLOCKED;
- stale or expired trusted context => BLOCKED;
- connector absent/unverified => DENY;
- read-only capability asked to write => DENY;
- agent scope broader than principal scope => DENY;
- wrong provider, target, operation or expired approval => DENY;
- revoked/replayed approval or active kill switch => DENY;
- valid request-bound approval => permit only the exact operation;
- unverified imported evidence cannot satisfy required verified evidence;
- secrets never appear in audit payloads;
- each execution and decision references a source revision and evidence digest.

## Deferred implementation

The policy evaluator now validates request-bound approval shape and exact binding, but cryptographic approval verification, revocation/replay storage, trusted-context signing, durable audit storage, external credential brokering, live provider adapters and production policy enforcement still require a server-owned integration layer and separate acceptance evidence. The evaluator's verifier callbacks must only be supplied by that trusted server-side composition root.

This document does not claim durable storage, production isolation, a completed red-team exercise or security certification.
