# ADR-002 — Declarative Adapter Contract and Exact Version Negotiation

Status: Accepted for WP-04.1.  
Date: 2026-11-27

## Context

The platform needs self-describing adapters, but descriptor data must not become a trust decision. Existing integration-registry and integration-capability-registry helpers already model lifecycle and capability policy.

## Problem

A manifest that combines implementation metadata, capabilities, provider API versions, event schemas and authorization state can accidentally imply that a declared capability is verified or executable. One universal version field also hides protocol and configuration incompatibilities.

## Decision

Introduce a closed, declarative 3XT-ADAPTER v1 contract. It contains pinned implementation provenance fields, separate version dimensions, declared capabilities and bounded operation semantics. The validator is pure and has no network, storage, credential or code-loading behavior.

Negotiate exact supported versions only. Any unmatched contract, event schema, protocol, provider API, configuration schema or capability version yields an unsupported result. No implicit mapping or downgrade is performed.

Reuse the existing lifecycle and capability policy modules. Do not create a parallel adapter registry or authorization engine in this increment.

## Alternatives

- Accept open-ended JSON manifests — rejected because unknown fields can carry authority-like claims and inconsistent semantics.
- Use one generic version string — rejected because independent protocol and configuration version changes would be ambiguous.
- Let the manifest mark itself trusted or WRITE_ENABLED — rejected because declarations are not evidence of trust.
- Add a dynamic package loader in v1 — deferred until provenance, integrity, isolation and operator approval gates are implemented.

## Security implications

Unknown fields, accessors, proxy objects, unsafe source paths, undeclared capabilities, duplicate IDs and non-replayable operations with multiple attempts are rejected. Manifest validation is not authentication, approval or authorization.

## Reliability implications

Exact matching makes unsupported compatibility explicit. Unknown provider idempotency remains one attempt and requires reconciliation.

## Data implications

The artifact digest is recorded as a declaration and must be independently recomputed by the registration process. Credential values are not part of the contract.

## Compatibility implications

Current STEEL main's factory protocol is distinct from the historical Fabric source snapshot used by KRATT's tests. A future mapping must have its own versioned adapter and conformance tests.

## Consequences

WP-04.1 supplies deterministic validation and compatibility decisions. WP-04.2–04.4 must add host-owned registration, authorization binding and runtime isolation before any adapter can execute.

## Validation evidence

- Unit suite: packages/kratt-core/test/adapter-contract.test.mjs.
- No external provider calls, STEEL writes or live execution performed.

## Revisit conditions

Revisit when a concrete provider requires multiple concurrently supported protocol or configuration versions, or when verified artifact provenance can be integrated into the registry.
