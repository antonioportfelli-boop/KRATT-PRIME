# SMF-01 — Semantic Morphosis Fabric

Status: feature-branch implementation baseline; not production-enabled.
Version: 1.0.0
Package: packages/kratt-core

## 1. Purpose

SMF-01 is a semantic integrity and representation-transformation layer for KRATT PRIME. It adds two project-defined concepts to the existing SIPA-11 semantic-integrity foundation:

- Kõrre-löödav anti-semantika — counterexample-driven anti-semantics: a claim or interpretation must be exposed to structured attempts to falsify it. A missing counterexample is not proof that the claim is true.
- Polümorfoos — controlled transformation of one canonical semantic identity into multiple representation forms while preserving required invariants and declaring every permitted loss.

The expression “kõrre-löödav” is treated as a project term, not a claim that a settled scientific or standards definition exists. It is explicitly not the logical straw-man fallacy: the engine must challenge the strongest supplied interpretation, not a deliberately weakened caricature.

## 2. Five non-interchangeable semantic dimensions

Each identity stores these dimensions independently:

| Dimension | Operational question | Example |
|---|---|---|
| wordContent | What is the lexical/content form? | Original token, phrase, language form |
| meaning | What does it denote in this context? | Contextual interpretation |
| principle | Which rule must govern it? | Approval is not authorization |
| effect | What consequence is intended or observed? | Read-only operation |
| authority | Who may authorize or control the operation? | Scoped permission from a policy issuer |

A change to one dimension does not silently rewrite another. In particular, lexical or interpretive changes cannot expand authority. This is a core invariant, not a user-interface convention.

## 3. Runtime components

### 3.1 Semantic Identity Registry

createSemanticIdentity(input) accepts a JSON-compatible data object with stable id, version, a context object, and all five dimensions. It rejects unsupported runtime values, accessors, cycles, sparse arrays, hidden properties, unsafe keys, and non-finite numbers, then returns a canonical deep-frozen value.

### 3.2 Anti-Semantic Challenger

evaluateAntiSemanticChallenge({ source, candidates }) structurally compares supplied counter-interpretations with the source identity and declared semantic constraints.

Decisions:

- COUNTEREXAMPLE_FOUND: at least one candidate violates a declared invariant.
- NO_COUNTEREXAMPLE_FOUND: none of the supplied candidates violated the checked structure. This is not proof of truth.
- INCONCLUSIVE: there was no usable source or candidate coverage, or a candidate could not be safely compared.

The current implementation is deterministic and structural. It does not itself perform natural-language inference, verify factual claims, assess the truth of a source, or select a winning interpretation when evidence conflicts. AI systems may propose candidate interpretations, but those proposals are untrusted data.

### 3.3 Polymorphosis Transformer

executePolymorphosis({ source, profile, toTarget, toCanonical }) transforms a canonical identity through an application-supplied, trusted transformer. The profile is versioned and declares:

- Target form and round-trip policy.
- Source-to-target path mappings.
- Mandatory mappings for identity and all five semantic dimensions.
- Explicit reasons for any permitted non-protected field loss.

Protected fields — identity, version, the five dimensions, modality, subject, scope, conditions, freshness, provenance, and prohibited equivalences — cannot be declared lossy. Silent top-level field loss is rejected. A required round trip must restore every non-lossy source field.

authorityGranted is always false. Transformation is not authorization and never performs an external write.

### 3.4 SIPA-11 pipeline

runSemanticMorphosisPipeline(input) composes the existing SIPA-11 engines with the new layer:

1. Talmud preflight: source preservation, evidence, provenance, request-scoped authority and conflict gates.
2. Anti-semantic challenge: require usable counter-interpretation coverage and no unresolved structural counterexample.
3. Polymorphosis: perform the versioned transform and invariant/round-trip checks.
4. Anti-Talmud postflight: compare independently observed canonical output to the expected identity.
5. On divergence: open a correction proposal; keep Echo restoration gated.

A successful preflight is not a permission grant. Existing policy, request-bound approval and authorized-dispatch checks remain authoritative. The pipeline does not execute any external action.

### 3.5 Meridian audit integration

appendMorphosisAuditEvent(chain, event) appends a typed SMF_POLYMORPHOSIS node via the existing SIPA-11 Meridian implementation. Digest chains provide tamper-evident linkage, not factual truth or source authority. Provenance and evidence checks remain separate.

## 4. Decision and safety model

| Situation | SMF-01 outcome |
|---|---|
| Talmud preflight fails | BLOCKED |
| Counterexamples missing or unresolved | BLOCKED / INCONCLUSIVE |
| Mapping, protected invariant, or required round trip fails | BLOCKED |
| Independent postflight evidence missing | QUARANTINE |
| Observed result diverges | FINDING + correction proposal only |
| Independent postflight agrees | PASS for the representation check only |

Correction Forge creates a reviewable proposal; it cannot self-approve or self-apply privileged changes. Echo restoration requires Meridian restoration, separate approval, and invariant checks. Restoration is conformity to an authorized constitution version, not an opportunity to rewrite that constitution.

## 5. Trust boundaries

- Model, provider, connector, uploaded-file and user-provided content is untrusted input.
- The source/evidence verifiers that populate Talmud preflight booleans must be trusted internal components, not values copied from model output or client state.
- Transformer functions are trusted application code. This module is not a JavaScript sandbox. Never load executable adapters from unverified provider payloads.
- Read, transform, propose, approve and write are separate capabilities.
- External writes retain the existing integration lifecycle, least-privilege rules, request-bound approval and audit trail.
- Missing, stale, conflicting or unverifiable evidence must fail closed.

## 6. Integration placement

| Existing component | Responsibility boundary |
|---|---|
| KRATT PRIME / kratt-core | Identity, challenge, transform and audit APIs |
| SIPA-11 Talmud | Preflight and evidence/authority checks |
| SIPA-11 Anti-Talmud | Independent postflight and mismatch detection |
| Meridian | Provenance-linked history |
| Correction Forge | Reviewable repair proposals |
| Echo Restorer | Gated rebuilding of affected projections |
| ARPA-5 M3 | Consume unresolved semantic/policy contradictions; fail closed |
| ARPA-5 M5 | Preserve typed semantic memory and provenance |
| GOLIATH OS | Future orchestration boundary; no privilege comes from SMF-01 |
| STEEL / AURA / FRAME.9 | Future targets through separately reviewed transform profiles |

These are integration boundaries and intended consumers, not claims that every downstream adapter is already implemented.

## 7. Initial acceptance criteria

The SMF-01 slice is acceptable only when tests cover dimension separation, accessor/cycle rejection, counterexample detection, inconclusive challenge coverage, protected-field preservation, declared-loss enforcement, required round-trip behavior, Talmud fail-closed behavior, independent postflight quarantine, correction proposal creation, Echo gating, and Meridian audit append.

Unit-test success covers only exercised code paths. It does not prove semantic truth, complete security, correct real-provider permissions, or production readiness.
