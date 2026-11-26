# WP-04.1 — Declarative Adapter Contract Foundation

Status: implementation candidate on feature/wp-04-adapter-contract-foundation-2026-11-27.  
Scope: closed manifest validation and exact-version compatibility negotiation.

## Purpose

Provide one deterministic, versioned description of an adapter's declared implementation, protocol dependencies, capabilities and operation semantics. The contract is consumed by a future host-controlled registry and runtime; it is not itself a trust or authorization object.

## Contract dimensions

The v1 contract keeps version dimensions separate:

| Dimension | Contract field | Meaning |
|---|---|---|
| Adapter contract | contractVersion | Version of this manifest contract. |
| Event schema | versions.eventSchema | Event envelope schema identity and version. |
| Wire protocol | versions.protocol | Transport/protocol identity and version. |
| Provider API | versions.providerApi | Provider API identity and version. |
| Configuration schema | versions.configuration | Configuration schema identity and version. |
| Capability | capabilities[].version | Version of each declared capability. |
| Implementation | implementation.version | Version of the adapter implementation. |

The implementation source is pinned by repository, 40-character source revision, relative source path and SHA-256 artifact digest. A digest supplied by a manifest is not proof that the artifact was independently verified; the future registration process must recompute and compare it.

## Operation declaration

Each operation declares:

- operationId;
- class: READ, EXTERNAL_WRITE or DESTRUCTIVE_WRITE;
- requiredCapabilities;
- idempotency class: IDEMPOTENT, DEDUPLICATED, AT_MOST_ONCE_ATTEMPT or UNKNOWN_EXTERNAL_SEMANTICS;
- bounded timeoutMs;
- maxAttempts.

READ must declare IDEMPOTENT semantics. AT_MOST_ONCE_ATTEMPT and UNKNOWN_EXTERNAL_SEMANTICS must set maxAttempts to 1. This is a contract validation rule, not permission for the runtime to retry. A future runtime must apply its own provider-specific retry and reconciliation policy.

## Validation and negotiation

adapter-contract.mjs provides:

- normalizeAdapterContract — strict closed-shape validation, safe source path validation, uniqueness checks, capability reference checks, semantic retry bounds and immutable normalized output;
- validateAdapterContract — a stable result with safe error codes and no rejected payload reflection;
- negotiateAdapterContract — exact matching of contract, event schema, protocol, provider API, configuration schema and capability versions.

Unknown or unmatched critical versions fail closed. v1 does not perform coercion, field stripping, implicit mapping, automatic downgrade or semantic version range evaluation.

## Explicit non-authority guarantees

A validated or compatible contract does not:

- authenticate an adapter;
- verify its artifact digest against a trusted artifact source;
- register or trust the adapter;
- assign lifecycle state or capabilities;
- create an authorization grant or approval;
- resolve credentials;
- assign tenant scope;
- load or execute code;
- authorize READ or WRITE;
- guarantee provider idempotency or external exactly-once behavior.

The execution mode is a declaration only. IN_PROCESS_TRUSTED is not a self-granted trust level. The host must independently decide whether and how to execute the artifact.

## Tests

adapter-contract.test.mjs covers valid normalization, immutability, closed object shape, accessor/proxy rejection, source path and digest validation, duplicate IDs, capability references, operation semantics, exact version matches, unsupported versions and no implicit downgrade.

## Next dependencies

WP-04.2 must establish host-owned adapter identity, registration and lifecycle transitions. WP-04.3 must bind declared capabilities to the existing trusted policy/approval system. WP-04.4 must define the runtime execution context and isolation model. No new registry, authorization engine or workflow engine should be created unless a gap is proven.
