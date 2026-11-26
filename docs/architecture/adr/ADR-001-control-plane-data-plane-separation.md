# ADR-001 — Control Plane and Data Plane Separation

Status: Accepted as a logical architecture boundary; complete runtime enforcement is pending.  
Date: 2026-11-27

## Context

KRATT PRIME already has policy, approval, integration-capability, Saga, journal, outbox and Fabric components. Their trust and execution responsibilities must remain distinct as adapter support expands.

## Problem

If an adapter or worker can register itself, assign capabilities, change policy or elevate its lifecycle state, the system becomes a confused deputy. Conversely, splitting every responsibility into a separate service now would add operational complexity without proving a need.

## Decision

Keep control-plane authority in a trusted host composition root. It owns identity, source provenance, adapter registration, lifecycle transitions, capability resolution, policy, approval, revocation, configuration and audit authority.

Keep data-plane execution bounded. It consumes a current, request-bound decision and performs only the authorized operation through a bounded adapter context. It owns transport, delivery, ACK receipt, retries within policy, durable result handling and reconciliation.

The modules may remain in one process initially. The boundary is defined by data ownership, APIs and authority, not by deployment topology.

## Alternatives

- One autonomous adapter process with self-managed identity and permissions — rejected because it lets the adapter establish its own authority.
- Separate microservice for every registry, policy and worker function — deferred because there is no measured deployment or isolation need yet.
- A single unrestricted integration module — rejected because discovery, policy and external side effects would share an authority boundary.

## Security implications

The data plane cannot mutate control-plane policy, capability grants, identity trust or audit authority. Workers must revalidate cancellation and lease fences before an external call. Health recovery must never re-enable WRITE.

## Reliability implications

A provider failure remains isolated to its adapter/queue. Unknown outcomes are reconciled, not blindly retried. Durable intent and ACK evidence remain authoritative.

## Data implications

Identity, tenant scope, request digest, policy revision, event identity and operation scope must remain bound across persistence records. Tenant enforcement remains a separate open gap.

## Compatibility implications

Adapter contracts and protocol versions are independently versioned. Compatibility negotiation cannot alter trust or authorization semantics.

## Consequences

The current implementation provides policy primitives and WP-03 delivery controls, but not a fully isolated adapter runtime. WP-04.1 adds declarations only. Later WP-04 work must preserve this decision.

## Validation evidence

- Main architecture: docs/architecture/SYSTEM-ARCHITECTURE.md.
- WP-03.9 tested delivery fence and reconciliation: PR #61 at 98ec935c25f220f5c0e7b4f4a35eaeb989753b8e.
- No live provider or staging execution was performed.

## Revisit conditions

Revisit process isolation when adapters are third-party, dynamically supplied, untrusted, resource-heavy, or require independent failure domains.
