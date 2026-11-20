# KRATT PRIME ↔ STEEL Factory Protocol v1 compatibility

**Status:** adapter implementation present; upstream source snapshot pinned; live cross-repository CI is not connected.  
**Upstream:** STEEL Factory Protocol v1 on the organization repository's main branch.  
**Consumer:** packages/kratt-core/src/steel-factory-protocol-adapter.mjs

## Pinned source of truth

The source blob SHAs captured on 2026-11-20 are recorded in
\`packages/kratt-core/contracts/steel-factory-protocol-v1.sources.json\`.

| STEEL source | Captured blob SHA |
|---|---|
| factory/protocol/types.ts | f4bac7b6273867b488b3f6044b14bacc7faf0716 |
| factory/protocol/spec.ts | b17f0964420b2a7509ccf3689c0f3f8bc0ae5006 |
| factory/protocol/protocol.schema.json | 3525f956e7a06eaf76413a96c8d9a7d184d41c3a |
| factory/tests/protocol.test.ts | d9eaa683a490634619ac37e9d2f73f3c2d3f807a |

These values are an inspectable upstream snapshot, not an automatic dependency fetch. When STEEL changes its protocol, refresh the manifest and repeat the compatibility review before changing the KRATT adapter.

## Contract alignment

The KRATT adapter maps the STEEL TaskEnvelope into a strict KRATT task and preserves the protocol binding (task, repository, branch, base SHA, agent/factory and exact scope). ActionReceipt acceptance additionally requires:

- exact task, agent, repository and base SHA match;
- exact expected action and scope match;
- protocol state VERIFIED and successful result with zero failed checks;
- a server-injected independent receipt verifier returning true.

A protocol flag or producer-authored evidence object is not a signature or proof by itself.

## Hardening performed in this increment

- Inputs are recursively snapshotted from own data-property descriptors before validation. Getters, proxy traps, symbols, sparse arrays, cycles, non-JSON values, unsafe object keys, and excessive depth/size fail closed.
- Objective text rejects the invisible, bidi and formatting characters rejected by the upstream STEEL protocol validator. ZWNJ/ZWJ remain accepted according to the upstream comment.
- The branch component rules match the upstream ref checks.
- Expected receipt scope is snapshotted and validated before it is compared or passed to the independent verifier.

## Remaining integration work

1. Add a coordinated STEEL CI contract job that compares the upstream blob SHAs and runs the same positive/negative envelope and receipt vectors in both repositories.
2. Replace the adapter's evidence-claim map with a centrally versioned mapping owned by the cross-repository contract.
3. Add a real server-owned ActionReceipt verifier backed by the chosen cryptographic/provenance trust service; keep the adapter default-deny until it is injected.
4. Test the complete STEEL dispatch → KRATT authorization → outbox → receipt verification flow against a staging PostgreSQL instance.
5. Do not enable repository writes, merge actions, or external dispatch from the adapter merely because protocol validation passed.

The adapter currently remains a contract boundary. It does not create STEEL credentials, write to STEEL, start agents, dispatch providers or deploy either application.
