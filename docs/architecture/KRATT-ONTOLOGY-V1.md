# KRATT Ontology V1 — Reflection Root Contract

**Status:** versioned feature-branch contract; not yet approved as the permanent canonical business ontology.  
**Module:** `packages/kratt-core/src/reflection-ontology.mjs`  
**Version:** `kratt-ontology/v1`

## Purpose and authority

The validator turns the existing Claim/Evidence design constraints into executable graph invariants without pretending that the repository already contained a finalized ontology. The host must explicitly opt into `createOntologyValidatedReflectionRootStore`; the generic RootSnapshot/CAS reference adapter remains available for compatibility and synthetic fixtures.

The ontology preserves four distinctions:
- a source is not automatically evidence;
- a claim candidate is not an approved fact;
- evidence integrity is not the same as claim truth;
- a contradiction candidate is not a confirmed contradiction.

## Node types

| Type | Required semantic fields |
|---|---|
| SOURCE | source digest, observation time, rights status |
| SEGMENT | source ID, UTF-16 start/end offsets, excerpt digest |
| CLAIM | normalized text, extraction method, review state, source references |
| EVIDENCE | source ID/digest, stance, integrity state, lineage and independence group |
| CONTRADICTION | two distinct claim IDs, time scope, detection method, review status |
| DECISION | target, decision, reviewer, reason, policy version, evidence snapshot digest, decision time |
| BRANCH_RUN | root version/digest and run status |
| AGENT | role, explicit scope and status |

Every node carries a stable ID, UTC creation time, attributes and recomputable SHA-256 `recordDigest`. Model-extracted claims are required to remain `UNREVIEWED`; the validator rejects direct model promotion to `APPROVED`.

## Typed relations

V1 supports `SOURCE_HAS_SEGMENT`, `SEGMENT_SUPPORTS_CLAIM`, `EVIDENCE_SUPPORTS_CLAIM`, `EVIDENCE_CONTRADICTS_CLAIM`, `CLAIM_CONTRADICTS_CLAIM`, `DECISION_REVIEWS_CLAIM`, `BRANCH_RUN_PROPOSES_CLAIM`, `AGENT_PRODUCED`, `DERIVED_FROM`, and `PARENT_OF`.

The validator checks endpoint existence and endpoint types, unique IDs, timestamps, digest shapes, and acyclicity of derivation and parent-child relations. The root metadata must declare `ontologyVersion: kratt-ontology/v1`.

## Root integration

`createOntologyValidatedReflectionRootStore(database, options)` composes the existing SQLite CAS with mandatory semantic validation at:
1. initial root admission;
2. every durable root read;
3. the proposed post-delta document, before the CAS update commits.

An invalid semantic transition is denied and leaves root version, digest and audit journal unchanged. The production composition still needs the host's real decision store, trusted architect public-key ring, durable claim/evidence repository and operational key management. The validator is not an authentication or authorization substitute.

## Tests

`reflection-ontology.test.mjs` covers a valid source→segment→claim→evidence graph, model-claim promotion denial, missing endpoint denial, derivation cycle rejection, ontology-version enforcement, and CAS rejection of a semantically invalid transition.

`reflection-root-concurrency.test.mjs` uses two independent SQLite connections to one file-backed database. It verifies that two proposals based on the same root snapshot cannot both commit, and that replay remains idempotent after closing and reopening a connection.

## Remaining production decisions

- Ontology owner review of the V1 node/edge vocabulary and exact attribute fields.
- Domain-specific authorization for each relation and patch path.
- Shared serializable database adapter before multi-host deployment.
- Migration, backup, restore, retention and disaster-recovery exercises.
- Production provider adapters, trusted proxy configuration, external signer and key rotation procedure.
- Security audit remediation and independent code review.

No production root is seeded or changed by these tests or contracts.
