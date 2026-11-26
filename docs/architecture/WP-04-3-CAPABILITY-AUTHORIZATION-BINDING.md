# WP-04.3 — Capability Binding and Request-Bound Authorization

Status: implementation candidate on \`feature/wp-04-3-capability-authorization-binding-2026-11-27\`, stacked on WP-04.2 Draft PR #63.  
Scope: bind declared adapter operations to trusted principal, agent and integration scopes; request-digest-bound approval verification; durable one-time approval consumption contract; decision audit.  
Non-goals: provider execution, credential resolution, production database implementation, global WRITE enablement or tenant isolation.

## Decision path

1. Re-read the host-owned adapter registration and its current revision.
2. Resolve only an operation declared in the immutable 3XT-ADAPTER contract.
3. Convert each capability ID to a versioned scope reference \`capabilityId@version\`.
4. Load principal, agent and integration grants from the trusted server composition root. Caller-supplied grants are not accepted.
5. Calculate the effective scopes as the intersection of principal, agent and integration grants.
6. Check lifecycle, provider identity, target allow/deny scope and operation class with the existing capability policy helper.
7. For a future WRITE-enabled registration, verify the cryptographic approval against principal, agent, provider, operation, target, scope, expiry and the exact canonical request digest.
8. Consume the verifier-produced approval exactly once through the injected approval ledger.
9. Append a minimal decision event before returning a short-lived, module-branded authorization grant.

## Request digest extension

The existing approval envelope now carries an optional \`requestDigest\` field. When the authorisation request includes a digest (required by WP-04.3), the normalizer includes it in the normalized object passed to the cryptographic signature verifier. Missing or mismatched digests fail closed. Legacy callers without a digest remain compatible with the existing WP-01 contract; adapter authorization itself requires the digest.

The caller cannot set a \`verified\` flag to create a trusted approval. The authorization bridge only creates the policy approval projection after \`verifyApprovalForRequest\` returns a module-branded verifier result.

## Rights model

- Required scopes are versioned: \`repository.read@1.0.0\`, for example.
- Effective rights are the intersection of principal, agent and integration grants.
- Resource allow/deny values come from the trusted integration context, never from the user request.
- The adapter's manifest only declares what an operation needs; it does not grant the capability.
- Destructive operations require explicit destructive approval.
- The decision store must append the event; failure to persist audit blocks the grant.

## Current WRITE boundary

WP-04.2 registration records currently permit \`CONNECTED_UNVERIFIED\`, \`VERIFIED_READ_ONLY\`, \`DISABLED\`, and \`ERROR\`. They do not expose a route to \`WRITE_ENABLED\`. WP-04.3 preserves that boundary. A WRITE-enabled test fixture validates the future request approval/nonce path, but it is not a live capability: no production record can be promoted to \`WRITE_ENABLED\` by this package.

## Execution contract

This package never loads adapter code, resolves credentials, opens sockets or invokes a provider. It returns a branded, short-lived authorization decision for the WP-04.4 isolation boundary. Arbitrary objects with matching fields are rejected by \`isAuthorizedAdapterInvocation\`.

## Production dependencies still required

- A production registration store with transactional read/write and immutable revision guarantees.
- A trusted principal/agent/integration context loader backed by authenticated identity and current grants.
- A cryptographic approval verifier with trusted issuer/key lifecycle.
- A durable, transactional nonce/revocation ledger; the in-memory ledger remains test-only.
- An append-only audit store with failure semantics.
- Current policy/revocation checks at the effect boundary.

## Verification commands

\`\`\`sh
node --test packages/kratt-core/test/*.test.mjs packages/kratt-orchestrator/test/*.test.mjs
npm run typecheck
npm run build
\`\`\`

Passing CI proves only the repository tests/typecheck/build on the named commit; it is not production integration or security certification.
