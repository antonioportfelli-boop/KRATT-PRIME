# Wave 3 — 3XT Fabric interoperability

**Status:** implementation candidate; ingress-only; not production or staging approved  
**Branch:** `feature/wave3-fabric-interoperability-2026-11-26`  
**Stack base:** `feature/wave2-runtime-reconciliation-2026-11-26` at `c7ddaaef5e23bce31c758671152b3652bcb71b79`  
**Wave 2 PR:** [#58](https://github.com/antonioportfelli-boop/KRATT-PRIME/pull/58) remains open and Draft.

## 1. Source-of-truth findings

The repositories contain three distinct contracts. They must not be collapsed into one by renaming fields.

| Contract | Existing location | Purpose |
|---|---|---|
| KRATT local event | `packages/kratt-core/src/fabric-event.mjs` | Internal immutable `3xt-fabric-event/v1` event envelope |
| STEEL Factory protocol | `factory/protocol/types.ts`, `protocol.schema.json` | TaskEnvelope / ActionReceipt execution contract |
| STEEL Fabric wire protocol | STEEL development branch `feature/3xt-fabric-v1-event-contract`, file `factory/protocol/fabric-v1.ts` | Signed `3XT-FABRIC/1` inter-repository event |

The STEEL Fabric implementation was inspected at commit `1978fa37d5df7bfa6cb2a3ba64480307492893d5` (2026-11-11). It is a feature-branch artifact, not proof that the protocol is present on STEEL `main`. The KRATT Factory protocol adapter on older KRATT work (PR #31) handles TaskEnvelope/ActionReceipt and is not the same as a Fabric event transport adapter.

## 2. Protocol reconciliation

### Wire contract — STEEL 3XT-FABRIC/1

The accepted v1 envelope is closed-schema and consists of:

`protocol, event_id, event_type, source_node, destination_node, source_revision, correlation_id, parent_event_id, sequence, issued_at, expires_at, scope, payload_reference, evidence_references, key_id, payload, content_digest, signature`.

Validation currently requires:
- exact field set; unknown or missing top-level fields are rejected;
- protocol literal `3XT-FABRIC/1`;
- 40-character lowercase Git revision in `source_revision`;
- positive safe-integer source sequence;
- strict UTC timestamps and a maximum 24-hour event TTL;
- unique capability-token request scope;
- SHA-256 content digest over every field except `content_digest` and `signature`;
- Ed25519 signature over the domain-separated input `protocol + source_node + key_id + content_digest`;
- an event payload no larger than 256 KiB.

Canonical JSON processing follows the RFC 8785/JCS JSON data model: deterministic UTF-16 key ordering, finite JSON numbers, valid Unicode scalar values, plain data objects, and depth/node bounds. KRATT snapshots the input before reading nested fields, rejects proxies/accessors/sparse arrays/cycles/unsafe keys, and deeply freezes the accepted snapshot. This prevents sender-owned object mutation and getter side effects from changing what gets hashed or authorized.

### Canonical model — 3xt-fabric-canonical-event/v2

KRATT maps the verified wire event into a neutral canonical shape:

- `identity`: immutable event id and event type;
- `provenance`: source node, source revision, signing key, destination and time bounds;
- `causality`: correlation id and parent event id;
- `ordering`: source sequence;
- `authorization_request`: requested scope (not an authorization grant);
- `references`: payload and evidence references;
- `payload`: unchanged business payload;
- `integrity`: wire digest and Ed25519 signature metadata.

STEEL v1 does not carry KRATT's legacy `source.agent_id` or `source.component`. The canonical model marks both `null`; it does not infer an agent from the node name, event type, payload or signing key. Any future enrichment must come from a separately trusted registry and be recorded as such.

### KRATT local event compatibility

KRATT's existing `3xt-fabric-event/v1` remains unchanged. It is an internal event contract and does not contain all transport metadata (destination, expiry, requested scope, evidence references, key identity or signature). Therefore it is not safe to deserialize a STEEL wire event directly into that legacy type. The canonical v2 model is the reconciliation boundary; a future local projection must explicitly represent every omitted transport field or return a deterministic mapping error.

No automatic field aliasing, unknown-field stripping, payload rewriting or version downgrade is permitted. Unknown wire protocol versions fail closed.

## 3. Trust and authorization

The ingress API requires two separate server-side resolvers:

1. `resolveTrustedKey(source_node, key_id)` binds the exact source node and key id to a trusted Ed25519 public key and lifecycle status.
2. `resolveNodePolicy(source_node, authenticatedIdentity)` returns server-owned source status, allowed destinations, allowed event types, allowed scope and optional policy revision.

The signed `scope` is a request from the sender. KRATT compares every requested capability with the server-owned allow-list. Payload values are never considered authorization inputs. Destination, node identity, event type and key id are separately bound.

Key lifecycle semantics:
- `ACTIVE`: may verify events signed in the permitted key validity window;
- `VERIFY_ONLY`: may verify only events issued on or before `retired_at`, optionally bounded by `verify_until`;
- `REVOKED`, `COMPROMISED`, `DISABLED`: deny, including historical events.

Key lookup and policy evaluation fail closed. Key material is supplied by an injected trusted resolver; this module neither generates nor stores private keys and does not rotate secrets.

## 4. Replay, ordering and causality

Migration `0003_fabric_interoperability.sql` adds:

- `kratt_fabric_event_inbox`: immutable event identity, source, destination, sequence, parent, digest, time bounds and event snapshot;
- a unique event id;
- a unique `(source_node, source_sequence)` constraint;
- a self-reference for a causal parent that must already exist;
- `kratt_fabric_source_heads`: one locked monotonic sequence watermark per source node;
- database triggers that reject inbox mutation and source-watermark rollback.

Ingress takes a PostgreSQL transaction, performs an idempotency lookup, locks the source watermark, re-checks for a concurrent duplicate, checks ordering and causal parent, inserts the immutable event, advances the source watermark, and invokes the local handler using the same transaction client. It acknowledges only after `COMMIT`.

Sequence policy is **strictly increasing, not contiguous**. A new event with a sequence greater than the last accepted sequence may be accepted; a gap is returned as `sequence_gap: true` for reconciliation/observability. A stale sequence or reused sequence is rejected. A repeated identical event id/source/sequence/digest is an idempotent duplicate. A different event reusing an id or source sequence is a conflict.

The database inbox is an at-most-once local reservation boundary, not a claim of exactly-once network delivery. Sender retries are expected. Expiry cleanup/retention is intentionally not included because inbox history is append-only; a separately reviewed retention/export policy is required.

## 5. Handler and side-effect boundary

The handler receives `{ client, authorization, sequence_gap }` and **must perform only transactional local database work through that supplied client**. It must not call an external HTTP API, send messages, deploy, write to another repository, or trigger an irreversible side effect. If the handler fails, the inbox insert and sequence watermark roll back together, and no acknowledgement is returned.

This work package does not register an external-effect adapter, enable outbox dispatch or turn on a worker. The Wave 2 controls remain:

```text
dispatch = false
externalEffects = false
```

No production deployment or external write is authorized.

## 6. Operational integration

Migration is reviewed DDL and is **not** executed automatically on application startup. Apply it only in an isolated staging database after:
- database role and grants have been reviewed;
- a backup/restore procedure has been tested;
- connection TLS and encryption-at-rest status have been verified by infrastructure evidence;
- migration and rollback/forward-recovery procedures have been reviewed;
- trusted node keys and policy records are provisioned from an independently controlled source.

Do not run the migration against production as part of this PR.

## 7. Deterministic failure outcomes

The adapter returns stable result codes for malformed envelope/snapshot, unsupported schema, invalid digest, unavailable/revoked key, invalid signature, policy denial, wrong destination, future/expired event, stale sequence, replay conflict, missing causal parent, database unavailable and handler failure. It never coerces a malformed envelope into a valid event.

## 8. Validation evidence and current limits

Local unit suite: `node --test packages/kratt-core/test/fabric-interoperability.test.mjs` — 15 passed, 0 failed.

The PostgreSQL integration test is separate and uses `KRATT_TEST_DATABASE_URL` plus the workflow's ephemeral PostgreSQL 16 service. It checks idempotency, concurrent duplicate delivery through two pools, monotonic ordering, sequence gaps, causal-parent requirements, transactional handler rollback/retry, and append-only database guards. A local run without a database URL skips this test; that skip is not PostgreSQL verification.

Current Wave 3 status at the time of this update:
- inbound 3XT-FABRIC/1 parsing, Ed25519 verification, authorization, PostgreSQL inbox, replay, ordering and causality: implemented and CI-verified;
- outbound 3XT-FABRIC/1 signing, task-bound approval verification boundary, source sequence reservation, and atomic PostgreSQL intent/outbox/event/audit persistence: implemented and CI-verified;
- unit suite for outbound composition: eleven focused tests;
- live PostgreSQL 16 suite: three integration tests (runtime journal/leases, Fabric inbox, Fabric outbound outbox), all run in CI with a live database, not skipped.

Remaining Wave 3 work:
- persist trusted node/key/policy registry with independently administered revocation/rotation audit semantics;
- end-to-end KRATT-to-STEEL and STEEL-to-KRATT contract fixtures against the STEEL implementation and pinned source revision;
- transport worker/provider registration, retry scheduling and cancellation-race reconciliation (currently deliberately not activated);
- schema evolution and compatibility negotiation;
- staging role/grant verification, backup/restore drill, connection TLS and encryption-at-rest evidence.

**KRATT can now prepare and durably queue authenticated outbound Fabric envelopes, but this is not yet live network delivery or a verified two-repository KRATT ↔ STEEL deployment. It is not staging-verified or production-ready.**


## 9. Outbound Fabric adapter and transactional outbox (WP-03.4)

The outbound adapter is a server-side composition boundary, not a network sender. It creates a signed STEEL-compatible `3XT-FABRIC/1` envelope and persists it into the existing KRATT PostgreSQL outbox. It does not invoke `claimOutbox`, instantiate `createOutboxWorker`, or perform HTTP, Telegram, repository, deployment or other external effects.

### Server-owned inputs

`createSteelFabricOutboundAdapter` requires injected dependencies:
- a trusted outbound policy resolver (source node, destination node, permitted event types, per-event scope, approval authority, key binding and TTL);
- a source revision resolver;
- an ACTIVE signing identity resolver and a signer callback;
- an approval signature verifier;
- server-side payload, evidence-reference, correlation, causal-parent and payload-reference resolvers;
- the existing PostgreSQL outbox store.

The publish request accepts a validated KRATT task, authenticated principal, request-bound approval, task-bound idempotency key and an event type. It does not accept caller-supplied destination node, scope, key id, source revision, payload or evidence references. Those values come from the server-owned resolvers. The signed `scope` is taken only from the trusted per-event policy.

The adapter checks that approval task/actor/operation/target/request digest/provider/authority and validity period bind to the exact task. The approval's provider is the task's own `task.constraints.provider`; it is not overwritten by the Fabric transport. The outbox provider is separately fixed to `fabric` for message delivery. The injected `verifyApproval` callback must perform cryptographic signature and request-binding verification without consuming the nonce; the PostgreSQL outbox transaction performs the durable one-time nonce consumption. This separation prevents an in-memory or second database nonce consume from racing the outbox commit.

### Sequence reservation and retry behaviour

Migration `0004_fabric_outbound.sql` adds:
- `kratt_fabric_outbound_heads`: monotonic sequence head per source node;
- `kratt_fabric_outbound_sequences`: immutable reservation tying a source node, idempotency key, request digest and source sequence;
- `kratt_fabric_outbound_events`: immutable signed event snapshot and digest, linked to the authorized dispatch intent and sequence reservation.

`reserveFabricSequence` serializes reservations per source node using a transaction-scoped advisory lock and row lock. Repeating the same idempotency key with the same request digest returns the same sequence. Reusing that key with a different request digest fails with `FABRIC_SEQUENCE_REQUEST_CONFLICT`. If signing or final intent persistence fails after reservation, the reservation remains and the same key can retry the same sequence; an abandoned reservation may create a visible sequence gap, which receivers already support.

The adapter derives a deterministic event id from the idempotency key. It computes the JCS/SHA-256 digest, obtains an Ed25519 signature through the injected signer, and independently verifies that signature against the trusted public key before attempting persistence.

The final call to `reserveAuthorizedIntent` inserts, in one PostgreSQL transaction:
1. the one-time approval nonce;
2. the cancellation guard and idempotency-bound intent;
3. the outbox payload with provider `fabric`;
4. the immutable outbound Fabric event record;
5. the append-only audit record.

An already committed idempotency key returns the stored signed event as a duplicate and does not allocate a new sequence or consume the nonce again.

### Key and side-effect boundaries

Only an `ACTIVE` outbound signing identity is accepted. The module never generates, stores, exports or rotates private keys; the signer is injected and the returned signature is checked against a separately resolved public key. Retired/revoked outbound key workflows and persisted trust-registry management remain follow-on work.

The new outbox row is committed in `PENDING` state. It is not claimed or dispatched by this adapter. An operator must separately review worker registration, destination transport, retry semantics and external-effect authorization before any delivery can be enabled. Network delivery remains at-least-once; stable event and idempotency identities are required for receiver deduplication.

### WP-03.4 verification

The outbound unit suite covers signed event creation, server-derived scope/payload/evidence, disallowed event types, approval/time/principal binding, signing-key mismatch, duplicate idempotency and request-digest conflicts. The PostgreSQL 16 integration suite creates an isolated schema, reapplies migrations, races two outbox stores against one idempotency key, verifies the persisted event signature, checks immutable guards (including sequence-head update and delete rejection), and asserts the outbox remains `PENDING` with zero attempts.

CI evidence for the previous verified outbound implementation snapshot `3e3d65e2b9fca960112ba1e60477820a321d23a8`:
- [Node 22 typecheck/build](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/45837077370)
- [KRATT core tests and application typecheck/build](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/45837077259)
- [PostgreSQL 16 runtime, inbox and outbound outbox integration](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/45837077302)

The database job ran three live PostgreSQL 16 integration tests and reported 3 passed, 0 failed. The ordinary core test step reports three database-dependent tests skipped because the separate live PostgreSQL step executes them against the CI database; the separate step is the database verification evidence. Later hardening changes that reject deletion of an outbound sequence head have been added after this evidence snapshot and require the next CI run before being counted as verified.
