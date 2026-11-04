# WP-01 — Authorization Hardening

Status: IMPLEMENTED IN CORE EVALUATOR / SERVER TRUST INTEGRATION REQUIRED

## Implemented controls

- Task must be in `PENDING` state. `CANCELLED` and `EVALUATED` tasks are denied.
- Trusted context must include an expiry and explicit kill-switch state.
- Trusted context is blocked when future-dated, expired or older than the configured maximum age (default five minutes).
- Policy matching is deterministic: duplicate rules for the same action produce `BLOCKED / POLICY_CONFLICT`.
- Target authorization requires exact resource identity and exact branch/path intersection where either side specifies a constraint.
- Missing `side_effect` is treated as `EXTERNAL_WRITE`.
- Every external write requires an approval artifact bound to task ID, actor, provider, operation, target and validity interval.
- Approval is rejected unless a trusted verifier callback returns exactly `true`.
- A caller-authored `result: VERIFIED` evidence record cannot satisfy required evidence unless a trusted evidence verifier callback returns exactly `true`.
- Verifier exceptions fail closed.

## Evaluator contract

`evaluatePolicy(task, evidence, trustedContext, options)`

The fourth argument is intended for a server-owned composition root:

- `now`: trusted clock value in epoch milliseconds (optional; defaults to system time);
- `maxContextAgeMs`: trusted freshness limit (optional; defaults to 300000);
- `approval`: request-bound approval artifact;
- `verifyApproval(approval, task, context)`: trusted verifier, must return boolean true;
- `verifyEvidence(evidence, task, context)`: trusted evidence verifier, must return boolean true.

Never accept verifier functions from a model plan, task payload, connector response or end-user request. This module validates the artifact shape and binding; it does not implement cryptographic signature validation or durable revocation/replay protection.

## Approval verifier requirements

A production verifier must independently establish:
- approval issuer authenticity (e.g. signature or authenticated approval-store record);
- approval ID and nonce uniqueness;
- approval not revoked or previously consumed;
- actor, task, provider, operation and target equality;
- issue and expiry times against a trusted clock;
- policy and principal authority at approval time and execution time.

## Evidence verifier requirements

A production verifier must independently establish:
- source identity and provenance;
- source revision and artifact digest;
- evidence freshness;
- result against the authoritative provider or CI record;
- claim subject and claim type;
- evidence has not been revoked or superseded.

## Remaining integration work

- Implement a server-owned composition root that loads trusted policy/context and verifier services.
- Persist approval nonce consumption and revocation state.
- Sign or otherwise authenticate trusted contexts.
- Emit redacted decision/provenance events to durable audit storage.
- Add connector-specific approval issuance and evidence verification adapters.
- Add integration and adversarial tests around replay, revocation, concurrent use and verifier trust boundaries.

## Verification boundary

Core contract tests cover deterministic decisions and fail-closed cases. Repository CI must still run the tests and app build. No production deployment or live external write is authorized by this work.
