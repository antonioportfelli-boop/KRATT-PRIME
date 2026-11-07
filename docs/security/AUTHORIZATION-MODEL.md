# Authorization Model
Status: Target contract; implementation status must be verified per branch

## Decision inputs
Authenticated principal; parent/child agent chain; connector identity and capability manifest; canonical task envelope/action/provider/target; trusted policy context and trusted time; independently verified evidence; request-bound approval; cancellation, revocation and global kill switch.

## Effective scope
Effective capabilities are the intersection of principal, organization, parent-agent, child-agent, connector, task and resource scopes. An absent or malformed scope is not unrestricted. Empty intersection means DENY.

## Side-effect classes
- READ_ONLY: no state mutation; still authenticated, scoped and rate-limited.
- LOCAL_WRITE: local durable mutation; policy evidence and approval according to policy.
- EXTERNAL_WRITE: remote mutation; request-bound approval and verified evidence required.
- IRREVERSIBLE: high-impact action; explicit high-authority approval and additional safeguards.
Unknown actions default to the most restrictive class unless an explicit reviewed allowlist says otherwise.

## Approval binding
Approval cryptographically binds schema version, approval ID, task ID and canonical task digest, actor, provider, exact operation, exact resource target, nonce, issue/expiry times, decision, approver identity, authority and key ID. Reject invalid signature, unknown/revoked key, wrong approver, authority mismatch, task/target mismatch, expired/future approval, excessive lifetime and nonce replay.

## Time and revocation
Trusted clock is injected by server composition root. No implicit wall-clock fallback is permitted. Clock errors, non-finite values and missing trusted time produce BLOCKED. Revocation and kill-switch state are checked immediately before execution.

## Decision semantics
ALLOW only when all controls pass. DENY when policy rejects or scope is insufficient. BLOCKED when trusted inputs/infrastructure are unavailable or invalid. INSUFFICIENT_EVIDENCE when required evidence is absent or unverifiable.

## Acceptance tests
Forged/empty evidence; missing/mismatched/expired/replayed approval; wrong key/approver/authority; invalid clock; stale context; policy conflict; scope widening; path traversal; cancellation race; kill-switch race; duplicate event IDs.