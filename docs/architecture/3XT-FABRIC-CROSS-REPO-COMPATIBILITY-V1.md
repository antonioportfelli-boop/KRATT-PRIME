# KRATT ↔ STEEL Fabric v1 Compatibility Review

**Review date:** 2026-11-26  
**Status:** wire-incompatible; trusted adapter required  
**Repositories:** KRATT PRIME main and STEEL feature/3xt-fabric-v1-event-contract

## Finding

The two repositories contain different event-envelope contracts. The current KRATT validator accepts schema_version = 3xt-fabric-event/v1. The STEEL feature branch defines protocol = 3XT-FABRIC/1. They are not interchangeable JSON envelopes and must not be connected by directly forwarding one payload into the other.

### KRATT event envelope

KRATT currently validates:
- schema_version, event_id, event_type
- source.node_id, source.agent_id, source.component
- occurred_at, correlation_id, causation_id, sequence
- payload

The KRATT module creates an immutable, structurally validated snapshot. Its documentation explicitly leaves producer authentication, signature verification, authorization and persistence to trusted adapters, policy and the durable event store.

### STEEL event envelope

STEEL's Fabric v1 feature branch expects:
- protocol, event_id, event_type
- source_node, destination_node, source_revision
- correlation_id, parent_event_id, sequence
- issued_at, expires_at, scope
- payload_reference, evidence_references, key_id
- payload, content_digest, signature

STEEL's ingress then applies bounded parsing, JCS content-digest verification, Ed25519 signature verification, a separate authorization callback, expiry checks and a transactional PostgreSQL inbox.

## Compatibility result

A valid KRATT event is not directly wire-compatible with the STEEL protocol. STEEL requires additional fields not present in KRATT's existing envelope: destination_node, source_revision, issued_at, expires_at, scope, payload_reference, evidence_references, key_id, content_digest and signature.

There are also semantic questions that must be decided, not guessed:
- occurred_at is not automatically the same thing as issued_at.
- causation_id is not automatically the same thing as parent_event_id.
- source.agent_id and source.component must not be discarded.
- scope must come from trusted server-side policy, not from an untrusted payload.
- source_revision, key_id, content_digest and signature require trusted provenance and cryptographic handling.

## Guard added in KRATT

packages/kratt-core/src/fabric-compatibility.mjs now validates the incoming KRATT envelope and returns TRUSTED_ADAPTER_REQUIRED rather than claiming wire compatibility. It explicitly reports missing target fields and semantic decisions. It does not transform events, generate signatures, connect to STEEL or dispatch events.

The test suite covers protocol identity, fail-closed compatibility classification, missing target fields, invalid KRATT events and semantic mapping safeguards.

## Required next implementation

1. Agree one canonical event contract and versioning policy across KRATT and STEEL.
2. Define a trusted adapter contract with server-derived destination, source revision, scope and evidence references.
3. Keep node key resolution, signing and signature verification inside trusted server-side components.
4. Add identical cross-repository test vectors and negative cases for replay, duplicate IDs/sequences, stale timestamps, invalid signatures and revoked keys.
5. Only after both sides pass the same vectors, mark the edge VERIFIED_READ_ONLY. External writes require a separate WP-01 approval and authorized-dispatch review.

Until then, Fabric integration stays CONTRACT_IN_PROGRESS and cross-system reads/writes remain disabled.