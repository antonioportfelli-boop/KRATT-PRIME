# WP-04 — Trust Boundary and Dependency Map

Date: 2026-11-27  
Purpose: define which component owns authority, which component may execute side effects, and what is actually integrated.

## Logical trust boundary

    UNTRUSTED REQUEST / AGENT OUTPUT / PROVIDER RESPONSE
                         |
                         v
                 INPUT VALIDATION
                         |
                         v
    CONTROL PLANE — trusted host composition root
      identity resolution and source provenance
      adapter contract validation
      host-owned registration and lifecycle authority
      source artifact digest and conformance verification
      capability registry and scope intersection
      policy, approval verification and revocation
      version compatibility decision
      audit authority and configuration validation
                         |
                 scoped execution grant
                         |
                         v
    DATA PLANE — bounded execution path
      intent / outbox / worker claim
      owner + lease + cancellation fence
      adapter invocation under restricted context
      outbound transport and inbound callback validation
      ACK verification and result persistence
                         |
                         v
           AUDIT / RECONCILIATION / OBSERVABILITY

The control plane owns all trust and authorization decisions. The data plane may consume a current, bounded decision but may not create or widen one. A validated adapter contract is descriptive input to the control plane, not an authorization artifact.

## Module dependency map

### Mainline components at 782373cd7760a12141c75655dd890313c30f3021

| Responsibility | Existing implementation | WP-04 relationship |
|---|---|---|
| Policy and request-bound approval | packages/kratt-core/src/policy.mjs; approval-evidence.mjs; trusted-runtime.mjs | Reuse. Do not create a second authorization engine. |
| Authorized dispatch | packages/kratt-core/src/authorized-dispatch.mjs | Reuse as the future side-effect boundary; require contract operation binding before dispatch. |
| Integration lifecycle | packages/kratt-core/src/integration-registry.mjs | Authoritative pure lifecycle transition and operation-gate helper; reused by WP-04.2. |
| Capability decisions | packages/kratt-core/src/integration-capability-registry.mjs | Existing policy primitive; do not create a second capability registry. |
| Saga and execution state | packages/kratt-core/src/saga.mjs and the construction execution modules | Reuse existing state transitions and recovery semantics. |
| Local journal / audit | packages/kratt-core/src/prime-store.mjs and evidence-ledger.mjs | Reuse; do not treat local append-only storage as multi-host persistence. |
| Adapter manifest contract | packages/kratt-core/src/adapter-contract.mjs (WP-04.1) | Closed declaration validation, exact-version negotiation and pure operation resolution into the existing capability-policy input shape; no trust, authorization, I/O or execution. |
| Host adapter registration | packages/kratt-core/src/adapter-registration.mjs (WP-04.2 candidate) | Host-injected source reader, provenance verifier, conformance verifier and atomic store; metadata registration only, no loader, credentials or provider execution. |

### WP-03 feature-branch components — not mainline yet

WP-03.8 branch b34dd369fbfbbbfc425ecb8da762f3c9721a0e9d and WP-03.9 branch 98ec935c25f220f5c0e7b4f4a35eaeb989753b8e contain:

- Fabric parsing, digest validation and signed identity checks.
- PostgreSQL trust registry and immutable receiver receipts.
- Transactional outbox and delivery-start fence.
- Owner-bound leases, worker fencing and cancellation ordering.
- ACK authentication, ACK/outbox reconciliation and late-ACK ledger.
- Label-free Fabric metrics and PostgreSQL integration coverage.

PR #60 and PR #61 are open Draft PRs. The branch tests do not establish that these files are present on main or that an external provider is configured.

### STEEL protocol boundary

Current STEEL main is 1da5fd84d9ebb0a796326e3453d052ca73bc7650. Its current factory protocol directory contains spec.ts, types.ts and protocol.schema.json. This is a distinct integer-major factory protocol (protocol_version 1).

The file factory/protocol/fabric-v1.ts used by KRATT's WP-03 conformance fixture was read from historical STEEL commit 1978fa37d5df7bfa6cb2a3ba64480307492893d5. It is not present in the current STEEL main protocol directory. Therefore:

- the WP-03 test proves conformance to a pinned historical source snapshot;
- it does not prove current STEEL-main compatibility;
- it does not prove live transport, key provisioning, or receiver execution;
- any future mapping between STEEL factory TaskEnvelope and 3XT-FABRIC must be explicit and tested as a versioned mapping adapter.

No STEEL file or branch was changed in this work.

## Control-plane/data-plane contract

1. Registration and lifecycle transitions are host-owned.
2. A manifest cannot assign trust, WRITE_ENABLED state, approval, tenant scope or credential values.
3. WP-04.2 binds a registration to exact repository/revision/path bytes, recomputes the artifact digest and requires host-injected provenance evidence.
4. Read-only conformance is a separate verified transition using the existing integration lifecycle and an atomic revision/audit store contract.
5. Capabilities are declarations until intersected with trusted principal/agent grants and current policy.
6. Authorization grants are bound to a concrete request, principal, adapter, operation, resource and expiry.
7. Data-plane workers re-check current cancellation, lease and revocation fences immediately before a possible external call.
8. ACK receipt is an authenticated observation, not an authorization decision.
9. Unknown external outcomes remain RECONCILE until provider-specific evidence resolves them.
10. Recovery reads durable evidence; it never guesses that an external effect did or did not happen.

## Current gaps

- No canonical tenant identity or tenant isolation contract was found.
- The WP-04.2 store is an injected interface with an in-memory test double; a concrete transactional production store remains unimplemented.
- The provenance and conformance verifiers are host-supplied trust roots; their concrete signature/key lifecycle and policy configuration have not been independently verified.
- No adapter package loader/runtime isolation is enabled by WP-04.2.
- Provider-specific idempotency and live provider behavior remain unverified.
- STEEL's current main protocol and the historical Fabric snapshot need a formally reviewed mapping.
- No live STEEL callback/receiver or staging environment was exercised.
