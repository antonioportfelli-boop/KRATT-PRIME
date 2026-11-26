# WP-04 — Trust Boundary and Dependency Map

Date: 2026-11-27

## Control plane

- Validate the closed versioned adapter declaration.
- Bind exact pinned source and independently verified artifact provenance.
- Own registration identity and lifecycle.
- Load current principal, agent and integration grants from trusted server authorities.
- Intersect scopes and bind them to an exact operation and request digest.
- Verify signed approval and consume its nonce/revocation state.
- Append decision evidence before issuing a bounded authorization grant.

## Data plane

- Consume only a branded, short-lived grant.
- Re-read registration and verify its revision/digests immediately before worker start.
- Apply current revocation and cancellation fences.
- Pass a minimal immutable invocation context to an OS-isolated worker supervisor.
- Never create or widen authority.
- Reconcile unknown provider outcomes; never blind-retry an ambiguous effect.

## Reuse map

| Responsibility | Existing owner | New WP-04 layer |
|---|---|---|
| Contract | adapter-contract.mjs | WP-04.1 |
| Registration/provenance | adapter-registration.mjs + integration-registry.mjs | WP-04.2 |
| Capability policy | integration-capability-registry.mjs | Reused by WP-04.3 |
| Request-bound approval | approval-evidence.mjs | Extended with signed requestDigest |
| Durable replay | approval ledger interface | Host-injected; durable implementation remains external |
| Execution | authorized-dispatch.mjs + outbox worker | WP-04.4 consumes a WP-04.3 branded grant; no second auth engine |
| Isolation | OS process/container supervisor | Host-supplied platform boundary; not simulated by JS object freezing |

## Current gaps

- No canonical tenant ID and tenant-scoped persistence contract.
- Registration store, decision audit store and replay ledger require production transactional implementations.
- Verifier key lifecycle, revocation source and trusted context loader need controlled deployment configuration.
- WP-04.4 must enforce process/container isolation. Node Worker threads are not treated as a security boundary.
- No live provider operation or STEEL receiver has been exercised.
