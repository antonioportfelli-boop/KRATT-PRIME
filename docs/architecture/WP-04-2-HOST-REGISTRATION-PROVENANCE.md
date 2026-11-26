# WP-04.2 — Host-owned Adapter Registration and Provenance

Status: implementation candidate on \`feature/wp-04-2-host-registration-provenance-2026-11-27\`, stacked on WP-04.1 Draft PR #62.  
Scope: host-owned registration, immutable source binding, independently verified provenance, read-only conformance promotion, lifecycle audit.  
Non-goals: package loading, code execution, credentials, provider network calls, external WRITE, tenant isolation, production persistence.

## Objective

WP-04.1 established that a valid \`3XT-ADAPTER\` manifest is a declaration, not proof of identity or permission. WP-04.2 adds the next control-plane boundary: a host-controlled service registers a manifest only after it resolves the exact pinned source bytes, recomputes the artifact digest, and receives an independent provenance-verifier receipt.

It reuses \`adapter-contract.mjs\` and the existing \`integration-registry.mjs\` lifecycle. It does not create a competing registry or authorization engine.

## Registration sequence

1. Validate the closed manifest with \`validateAdapterContract\` / \`normalizeAdapterContract\`.
2. Negotiate every declared critical version against a host-owned compatibility profile. Unsupported versions fail closed; no downgrade is attempted.
3. Map declared operations into the existing integration lifecycle record. READ and WRITE declarations remain separate. Mapping fails if operation counts or identifiers do not fit the existing lifecycle contract.
4. Ask the injected source reader for exactly \`repository + immutable 40-character revision + relative path\`. Branch names, tags, mutable URLs and implicit default branches are not accepted as substitutes.
5. Recompute SHA-256 from the returned bounded bytes and compare it to the manifest's artifact digest.
6. Ask the host-injected provenance verifier to validate the source/artifact/contract binding. The caller and manifest cannot supply a trusted receipt.
7. Atomically create the record and append its minimal audit event using the host-owned store.
8. Read the record back and validate its contract digest, source binding, lifecycle mapping and revision before returning success.

## Read-only conformance promotion

A separate host-injected conformance verifier may attest that the pinned adapter passed the host's read-only contract suite. Only then can the existing transition function move the integration from \`CONNECTED_UNVERIFIED\` to \`VERIFIED_READ_ONLY\`.

The transition uses revision compare-and-swap and atomically appends an audit event. A second read checks that the revision did not change while the verifier was running. Missing, malformed, stale or failed evidence does not change state.

## Authority boundary

- The returned API exposes \`register\`, \`get\`, \`verifyReadOnly\`, \`disable\`, and \`markError\`.
- It deliberately exposes no \`load\`, \`execute\`, \`resolveCredentials\`, \`enableWrite\`, or grant-creation method.
- A declared write operation remains inert while state is \`CONNECTED_UNVERIFIED\` or \`VERIFIED_READ_ONLY\`.
- Existing \`authorizeIntegrationOperation\` rejects a write in \`VERIFIED_READ_ONLY\` with \`WRITE_NOT_ENABLED\`, even if a request-shaped approval is supplied.
- WP-04.3 remains responsible for binding capability declarations to trusted principal/agent/integration scope intersection and request-bound cryptographic approval.
- WP-04.4 remains responsible for execution context and worker/process isolation.
- The verifier implementations and compatibility profile are trusted host dependencies. This package validates their receipts; it does not itself establish their trust roots.

## Persistence interface

The injected \`registrationStore\` must implement:

- \`get(adapterId)\` — return the full registration record or \`null\`.
- \`createWithAudit({ record, auditEvent })\` — transactionally create the record and append the immutable audit event; return \`CREATED\`, \`ALREADY_EXISTS\`, or \`COMMIT_FAILED\`.
- \`compareAndSwapWithAudit({ adapterId, expectedRevision, record, auditEvent })\` — atomically check revision, update and append audit; return \`UPDATED\`, \`REVISION_MISMATCH\`, \`NOT_FOUND\`, or \`COMMIT_FAILED\`.

The store is supplied by the server composition root. The unit tests use an in-memory test double only. No PostgreSQL schema, migration, database credentials or production store is included in this slice. The atomicity guarantee must be tested by the concrete persistence adapter before production use.

## Source reader and verifier interfaces

\`sourceReader.readPinnedSource({ repository, revision, path })\` returns the exact same three identifiers and \`bytes\` (a bounded Uint8Array/Buffer). The runtime checks every identifier and recomputes the SHA-256 digest locally.

\`provenanceVerifier.verify({ repository, revision, path, artifactDigest, contractDigest })\` returns a closed receipt containing \`verified: true\`, \`evidenceRef\`, and \`verifierRef\`. The host verifier must independently check allow-listed origin, pinned commit/source identity, artifact provenance, signature/attestation policy and verifier/key lifecycle.

\`conformanceVerifier.verify({ adapterId, provider, contractDigest, artifactDigest, sourceProvenance })\` returns the same closed receipt shape. It must represent independent read-only conformance evidence, not a caller assertion or the manifest's own claim.

## Failure behavior

All invalid, mismatched, missing or unavailable inputs fail closed with stable error codes. The public result does not reflect rejected payloads or raw verifier exceptions. Record mutation and audit append must be atomic at the store boundary. Compare-and-swap conflicts are surfaced as revision changes; there is no blind retry.

## Verification

The focused test file covers digest mismatch, source identity mismatch, untrusted provenance, unsupported versions, duplicate registration, read-only attestation, fail-closed WRITE, lifecycle denial, CAS conflict, read-back tampering and store failures.

Required checks on the feature branch:

\`\`\`sh
node --test packages/kratt-core/test/*.test.mjs packages/kratt-orchestrator/test/*.test.mjs
npm run typecheck
npm run build
\`\`\`

A green unit/CI run is not a live provider integration, security certification, or proof that a production database store is correctly atomic.
