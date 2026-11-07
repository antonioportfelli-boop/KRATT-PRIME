# KRATT PRIME System Architecture
Status: TARGET ARCHITECTURE — not a claim of completed implementation  
Version: 3.0

## Logical layers
1. Control plane — task admission, orchestration, policy decisions and operator controls.
2. Policy and authorization — trusted context, identity, scope intersection, approval verification and kill switch.
3. Agent runtime — registry, scheduling, leases, lifecycle, budgets and cancellation.
4. Typed memory — durable facts/events, provenance, retention, conflict handling and retrieval.
5. Evidence and audit — source verification, immutable event history, decision records and integrity proofs.
6. Adapter gateway — GitHub, GitLab, Telegram, local APIs and external AI providers.
7. Presentation/platforms — AURA, STEEL, CERBERUS, FRAME.9 and Trinity Edge interfaces.

## Trust boundaries
- User/request payloads and agent outputs are untrusted until validated.
- Adapter responses are untrusted until authenticated and schema-validated.
- Only the server-owned composition root may inject trusted clocks, key registries, evidence verifiers and durable nonce stores.
- No client or agent may self-assign capabilities or elevate scope.

## Request lifecycle
1. Authenticate caller and resolve principal.
2. Validate canonical task envelope and idempotency key.
3. Load trusted context and effective policy.
4. Intersect principal, parent, child, connector, task and resource scopes.
5. Verify evidence provenance and freshness.
6. Verify request-bound approval when required.
7. Evaluate cancellation and global kill switch.
8. Persist decision and execution intent transactionally.
9. Dispatch through narrowly scoped adapter.
10. Persist outcome and audit event idempotently.
11. Return result with evidence references and explicit status.

## Module contracts
Core policy remains side-effect free where practical. Persistence interfaces document transaction and consistency guarantees. Adapters cannot bypass policy or create authority. UI surfaces display state but do not establish trust. Cross-module schemas are versioned and compatibility-tested.

## Deployment profiles
- Local single-host: SQLite may be acceptable for durable nonce/event state with tested backups and transaction semantics.
- Multi-host: use shared transactional storage and fencing/lease semantics; local SQLite does not provide distributed consistency.
- Offline/local-first: queue only permitted operations; revalidate authorization and freshness before replay.
- Production: disabled until key custody, observability, backup/restore, incident response and acceptance gates are approved.