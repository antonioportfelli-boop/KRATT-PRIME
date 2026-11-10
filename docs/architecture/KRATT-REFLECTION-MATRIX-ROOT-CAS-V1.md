# KRATT Reflection Matrix — RootSnapshot / RootDelta / CAS V1

**Status:** feature-branch reference implementation; local/synthetic only.  
**Branch:** `feature/kratt-telegram-control-plane-v1`  
**Authority:** KRATT PRIME core. Telegram is an input/review surface, not the root authority.

## Contract

### RootSnapshot V1
A versioned, immutable snapshot:
- `schemaVersion = kratt-root-snapshot/v1`
- monotonically increasing integer `version`
- `digest = sha256(canonical(document))`
- `document = { nodes: [], edges: [], metadata: {} }`
- UTC `createdAt`

The three top-level document collections are required. Snapshot digests are computed from canonical JSON with sorted object keys, finite numbers only, and no accessors, symbols, sparse arrays, exotic prototypes, or prototype-pollution keys.

### RootDelta V1
A bounded, deterministic JSON-Patch subset:
- `schemaVersion = kratt-root-delta/v1`
- 1–256 operations
- operations are `add`, `replace`, or `remove`
- JSON Pointer paths are restricted to `/nodes`, `/edges`, and `/metadata`
- root collection replacement, move/copy/test, arbitrary root paths, prototype keys, malformed pointer escapes, and oversized payloads are rejected
- maximum canonical delta payload is 128 KiB

This is a V1 implementation contract for the feature branch, not a claim that a pre-existing production Reflection Matrix schema was discovered. The domain-level meaning of node/edge fields still belongs to the KRATT ontology/schema owner and must be versioned before production use.

### CAS application
The SQLite adapter uses `BEGIN IMMEDIATE` and atomically:
1. validates the proposal envelope and RootDelta digest;
2. checks exact `expectedRootVersion + expectedRootDigest`;
3. calls the mandatory synchronous `createTrustedTelegramReflectionProposalVerifier` hook, which reloads the consumed decision and persisted public Ed25519 proof, rebuilds the exact request binding, and re-verifies the signature and expiry through the trusted architect public-key verifier;
4. applies the restricted delta to a cloned document;
5. increments root version and recomputes the snapshot digest;
6. updates the singleton root with a version+digest predicate;
7. inserts the unique proposal/decision application record;
8. appends a hash-linked audit event.

A stale root returns `STALE`; an exact replay returns `ALREADY_APPLIED`; an invalid signature or envelope fails closed. Root update, idempotency record, and audit event share one transaction. The adapter is single-host SQLite; multi-host use requires an equivalent serializable transactional store.

## Modules and tests
- `packages/kratt-core/src/reflection-root-store.mjs` — canonical snapshot, delta validation, SQLite CAS.
- `packages/kratt-core/src/telegram-reflection-proposal-verifier.mjs` — trusted re-verification and `createTelegramReflectionCasAdapter` composition.
- `packages/kratt-core/test/reflection-root-store.test.mjs`
- `packages/kratt-core/test/telegram-trusted-persistence.test.mjs` — end-to-end signed Telegram decision → proposal → CAS.

Synthetic tests cover initial snapshot integrity, restricted delta validation, successful CAS, replay, stale version, tampering, signature denial, restart persistence, and audit-chain verification.

## Integration boundary / no overclaim
This adapter does not yet make Telegram approval records a production root authority. Its mandatory `verifyProposal` callback must be wired to the canonical decision store and trusted Ed25519 verifier, and must revalidate the request/decision binding, expiry, policy version, claim/evidence digests, and architect authority. Until that adapter is wired and integration-tested, use this root store only with synthetic test data. The existing proposal builder remains non-mutating and does not itself apply deltas.

Before production:
1. confirm the KRATT ontology's authoritative node/edge schema and schema version;
2. provision the real architect public-key ring and trusted verifier through the host runtime; never commit private keys;
3. confirm the domain-level node/edge schema and add semantic authorization rules for each patch path;
4. add concurrency tests with two independent SQLite connections plus migration/backup/restore tests;
5. implement a shared serializable database adapter before multi-host deployment;
6. require separate explicit operational approval before enabling root mutation in a live environment.

No production root was seeded, changed, deployed, or connected by this implementation.
