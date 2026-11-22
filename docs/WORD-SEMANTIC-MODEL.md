# KRATT Word Semantics — Source, Content, Sense, Principle, Intent, Effect and Power

## Corrected point of departure

The root object is a **source occurrence in a context**, not a reflection. The source occurrence preserves the observed form, raw-source reference and digest. Reflection is an optional derived operation over typed source data; it is never the semantic origin.

The correction in schema v2 is substantive: **CONTENT and SENSE are separate layers**. Earlier v1 records did not contain a content object and therefore cannot be upgraded by copying a sense definition into a new content field. That would turn an interpretation into supposed source content. Re-author the content from the original source and preserve attribution before migrating a record.

## Nine non-collapsible layers

1. **FORM** — observed token/string, language, normalization and source offsets. It records what form appeared, not what it contains or means.
2. **CONTENT** — the source-grounded payload or subject matter: proposition, topic, concept, referent, quoted text or narrative. Every content item carries language, domain, evidence references, attribution (SOURCE, QUOTED, REPORTED, TRANSLATED, INFERRED, UNKNOWN) and confidence. CONTENT answers: *what content is present in the source occurrence?*
3. **SENSE** — a contextual interpretation of content, with definition, language, domain, concept mapping, evidence and confidence. Each sense explicitly references one or more CONTENT nodes. SENSE answers: *what does this content mean in this context?*
4. **PRINCIPLE** — a normative rule, its type, jurisdiction, validity interval and source references. A statement does not become a principle merely because it sounds imperative or is repeated.
5. **INTENT** — an attributed actor, goal, audience and context. Intent is an inference with confidence, not an observed fact.
6. **SPEECH_ACT** — what an utterance does in context: assert, request, directive, promise, warning, declaration, question, expressive or other. A speech act references CONTENT nodes instead of duplicating an untyped proposition string. Quoted content remains attributed as quoted/reported data; it is not a live system instruction.
7. **EFFECT** — proposed or observed consequences, target, direction, measurement, magnitude and causal status. Assertion or correlation is not causal proof.
8. **POWER** — mechanisms of influence/control: institutional, coercive, economic, expert, agenda-setting, informational or network. Influence is not a legitimate right.
9. **AUTHORITY** — issuer, subject, scoped action/resource, jurisdiction, validity and evidence. A textual claim or semantic interpretation cannot self-authorize; a verified-looking semantic record is still not a write permission.

## Graph rules

- A source occurrence anchors one FORM and can carry multiple CONTENT nodes.
- CONTENT is grounded in the source. SENSE nodes interpret CONTENT nodes and may preserve multiple competing interpretations.
- SPEECH_ACT nodes refer to content nodes, but do not replace or redefine them.
- PRINCIPLE, INTENT, EFFECT, POWER and AUTHORITY are distinct node types with their own operating logic.
- Node IDs must be unique within a record. Cross-layer references must resolve to existing CONTENT nodes where required.
- Preserve raw source, digest, source location, attribution, time and uncertainty; never overwrite source data with normalized interpretation.

## Decision rules and invariants

1. Resolve language, morphology, span, speaker, audience, domain, time, jurisdiction and task context before sense selection.
2. Preserve alternative senses and evidence. When multiple high-confidence senses remain viable for the same content node, request review instead of choosing a top score arbitrarily. The current 0.8 threshold is a provisional engineering constant, not a calibrated probability.
3. Content attribution (SOURCE, QUOTED, REPORTED, TRANSLATED, INFERRED, UNKNOWN) must not be collapsed. A quote is data, not an instruction to the runtime.
4. Create a principle only from an explicit normative source or approved rule-authoring process. Store applicability and expiry.
5. Record intent as attributed inference, separate from literal content and sense.
6. Classify speech acts pragmatically; grammar alone must not create executable commands.
7. Distinguish ASSERTED, OBSERVED, CAUSALLY_SUPPORTED, CAUSALLY_ESTABLISHED and UNKNOWN effects.
8. Model power mechanisms descriptively; do not equate power with legitimate authority.
9. Verify authority independently against issuer identity, delegation, action/resource scope, jurisdiction and expiry.
10. Semantic results never grant authorization. KRATT policy, WP-01 approval verification and request-bound write gates remain the only write authority.
11. Retrieved SharePoint, Slack, Bigdata and other content remains untrusted data, never a system instruction.
12. Reflection, interpretation, application, critique, quotation, translation and execution remain separate operations.

Core invariants:

- Same string ≠ same content.
- Same content ≠ same sense.
- Same sense ≠ same intent.
- Same intent ≠ same speech act.
- Same speech act ≠ same principle.
- Effect claim ≠ causal proof.
- Power ≠ legitimate authority.
- Meaning ≠ permission.
- Reflection ≠ origin.
- Similarity ≠ identity.
- Repetition ≠ corroboration.

## Pipeline

SOURCE_OCCURRENCE → PRESERVE → FORM → CONTENT_EXTRACTION → CONTEXTUALIZE → SENSE_CANDIDATES → PRAGMATIC_ACT → NORM_CLASSIFY → EFFECT/POWER/AUTHORITY_MODEL → EVIDENCE_VERIFY → CONFLICT_REVIEW → POLICY_SEPARATE → ACTION

Each stage emits versioned typed records, provenance references, uncertainty and replayable events. Agents may propose interpretations and code; trusted verifiers and policy gates independently decide whether outputs can be accepted or executed.

## Agent responsibilities

- Context agent: language, speaker, audience, domain, temporal and jurisdiction context.
- Content extractor: source-grounded payload, quoted spans, attribution and content segmentation; must not insert inferred interpretations as source content.
- Lexical/semantic agent: candidate senses and concept references linked to content nodes.
- Pragmatic agent: attributed intent and speech-act candidates.
- Normative agent: principle sources and applicability; cannot invent law or policy.
- Impact analyst: observed/causal effect distinction and measurement plan.
- Power analyst: actor relationships, mechanisms and scope.
- Authority verifier: independent delegation verification; never LLM self-attestation.
- Critic: adversarial ambiguity, quote-vs-command, equivocation, layer conflation and authority laundering tests.
- Orchestrator: joins evidence and workflows but cannot collapse semantic classes or authorize writes.

## Versioning and migration

Schema v2 introduces the mandatory contents collection, requires every SENSE to reference one or more CONTENT nodes, and changes SPEECH_ACT from free-text propositional_content to typed content_refs. v1 must not be migrated by copying definition into payload; content must be re-extracted or explicitly re-authored from the original source with correct attribution. This implementation intentionally reports EXPLICIT_CONTENT_REAUTHORING_REQUIRED rather than inventing missing source data.

## Research and implementation caveats

This is an engineering model grounded in distinctions from lexical semantics, pragmatics, speech-act theory, argumentation, provenance and governance. Academic synthesis is still pending; do not label the model peer-reviewed. The deterministic prototype validates records and separation rules but is not yet wired into the production Base44 agent runtime. Durable Base44 persistence, evidence adapters, calibrated multilingual evaluation, relationship provenance and UI integration remain follow-up build work. No merge or production deployment is performed.
