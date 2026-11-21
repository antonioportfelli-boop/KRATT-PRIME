# Wave 3 Foundation — AgentOps Trust Control Plane

**Status:** feature-branch implementation / review required  
**Branch:** `feature/agentops-trust-control-plane-v1`  
**Baseline:** `main` at branch creation  
**Deployment:** disabled; no production credentials or external writes are introduced.

## Objective

Establish a small, auditable contract boundary between KRATT PRIME and downstream
3XTRINITY runtimes. The first increment standardizes event envelopes without
replacing existing policy, authorization, Saga, agent-registry, or STEEL factory
implementations.

## Existing foundations retained

- KRATT PRIME owns task/evidence contracts, policy evaluation, agent registry,
  Saga state transitions, and WP-01 request-bound authorization.
- STEEL owns its factory dispatcher, protocol envelope, bounded KRATT stage,
  trust gate, replay ledger, and TÖEPÄRA verification boundary.
- A KRATT-produced receipt remains unverified until an independent verifier
  evaluates it. Event shape validation is not proof of producer identity.

## Wave 3 increment 1: Fabric event envelope

Implemented in `packages/kratt-core/src/fabric-event.mjs`:

- closed top-level schema and exact source shape;
- stable event, correlation, causation, and sequence identifiers;
- UTC timestamp and namespaced event-type validation;
- bounded JSON-only payload validation;
- deep-frozen cloned output to prevent post-validation mutation.

The validator deliberately does not:
- authenticate the producer or verify a signature;
- authorize an action or grant a capability;
- establish global ordering across nodes;
- deduplicate across processes;
- persist events or claim durable delivery;
- call GitHub, Telegram, AI providers, or any external service.

Those functions require separate trusted adapters, policy decisions, and durable
storage. A field such as `trusted: true` must never be treated as verification.

## Next acceptance gates

1. Map STEEL's existing `factory/protocol/types.ts` envelope to this contract
   through an explicit adapter; do not silently rename or discard fields.
2. Add canonical serialization and cryptographic digest rules with test vectors.
3. Define producer identity and key rotation outside caller-controlled payloads.
4. Bind event acceptance to KRATT authorization and cancellation/kill-switch state.
5. Add durable, idempotent event storage and replay tests before claiming delivery.
6. Add cross-repository contract fixtures and compatibility tests.
7. Keep all external write adapters disabled until separately approved.

## Verification status

The added Node test file is included by the existing
`node --test packages/kratt-core/test/*.test.mjs` command. Tests have not been
executed in this GitHub-only editing step. CI must provide the authoritative
runtime result before merge.
