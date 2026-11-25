# WP-01 Approval Evidence Engine — v1

Implements immutable approval-envelope normalization, exact request/principal/agent/provider/operation/target binding, scope and expiry checks, maximum lifetime, destructive-operation confirmation, fail-closed delegation to a trusted verifier, and an in-memory replay/revocation guard.

## Security boundary
This is a policy primitive, not a production authorization service. It does not implement signature verification, key custody, durable or distributed replay protection, revocation propagation, or a credential broker. The verifier must validate issuer, signature, key status and evidence provenance. The in-memory ledger is for tests and single-process prototypes only. No external writes are performed.

## Production integration
Replace the in-memory ledger with a durable transactional store and atomically bind consumption to the authorization decision and external side-effect boundary.
