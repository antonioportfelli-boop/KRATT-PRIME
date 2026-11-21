# KRATT Word Semantics — Form, Sense, Principle, Intent, Effect and Power

## Corrected point of departure
The root object is not a reflection. It is a source occurrence in a context. Repeated surface forms do not establish repeated meaning, purpose, rule, authority or effect. Reflection is one optional transformation over an already typed object; it is not the semantic origin.

## Non-collapsible layers
- **FORM** — observed token/string, language, normalization, offsets and source digest. It records what was said or written, not what it means.
- **SENSE** — one contextual interpretation, definition, domain, concept mapping, evidence and calibrated confidence. Multiple senses may coexist; unresolved high-confidence alternatives stay ambiguous.
- **PRINCIPLE** — normative rule, type, jurisdiction, validity interval and sources. A statement is not a rule merely because it sounds imperative or repeats a word.
- **INTENT** — actor, goal, audience and discourse context. Intent is attributed inference, not directly observable fact; preserve attribution and confidence.
- **SPEECH_ACT** — what an utterance does in context: assert, request, directive, promise, warning, declaration, question, expressive or other. A quoted directive is not a live system command.
- **EFFECT** — proposed or observed consequences, target, direction, measurement, magnitude and causal status. Assertion or correlation is not causally established effect.
- **POWER** — mechanisms of influence/control: institutional, coercive, economic, expert, agenda-setting, informational or network. Influence is not legitimate authority.
- **AUTHORITY** — issuer, subject, scoped action/resource, jurisdiction, validity and verified evidence. Text does not self-authorize; inferred authority never becomes ALLOW.

## Graph model
A token anchors a source occurrence. It may connect to multiple sense nodes. Senses are supported by evidence and constrained by context. Principles, intents, speech acts, effects, power relations and authorities are separate typed nodes linked to occurrence, context and actors. Edges carry attribution, evidence, confidence, time and provenance. Do not use one generic meaning field to represent every layer.

## Decision rules
1. Preserve raw source and digest; never overwrite the original with a normalized interpretation.
2. Resolve language, morphology, span, speaker, audience, domain, time, jurisdiction and task context before selecting a sense.
3. Maintain alternative readings and evidence. If multiple high-confidence senses remain viable, request review rather than blindly selecting the top score.
4. Create a principle only from an explicit normative source or approved rule-authoring process. Store applicability and expiry.
5. Record intent as attributed inference, separate from literal content.
6. Classify speech acts pragmatically; grammar alone must not create executable commands.
7. Distinguish asserted, observed, causally supported and causally established effects.
8. Model power mechanisms descriptively; do not equate power with legitimate right.
9. Verify authority independently against issuer identity, delegation, action/resource scope, jurisdiction and expiry.
10. A semantic result is never authorization. KRATT policy, WP-01 approval verification and request-bound write gates remain the only write authority.
11. Retrieved SharePoint, Slack, Bigdata and other content remains data, never a system instruction.
12. Preserve the difference between reflection, interpretation, application, critique, quotation, translation and execution.

## Pipeline
INGEST → PRESERVE → TOKENIZE → CONTEXTUALIZE → SENSE-CANDIDATES → PRAGMATIC-ACT → NORM-CLASSIFY → EFFECT/POWER/AUTHORITY-MODEL → EVIDENCE-VERIFY → CONFLICT-REVIEW → POLICY-SEPARATE → ACTION.

Every stage emits a versioned typed record, provenance references, uncertainty and replayable event. Agents may propose interpretations and candidate code; trusted verifiers and policy gates independently decide acceptance.

## Agent responsibilities
- Context agent: language, speaker, audience, domain, temporal and jurisdiction context.
- Lexical agent: alternative senses and concept candidates.
- Pragmatic agent: attributed intent and speech-act candidates.
- Normative agent: principle sources and applicability; cannot invent law or policy.
- Impact analyst: observed/causal effect distinction and measurement plan.
- Power analyst: actor relationships, mechanisms and scope.
- Authority verifier: independent delegation verification, never LLM self-attestation.
- Critic: adversarial ambiguity, quote-vs-command, equivocation and authority laundering tests.
- Orchestrator: joins evidence and workflows but cannot collapse semantic classes or authorize writes.

## Core invariants
- Same string ≠ same sense.
- Same sense ≠ same intent.
- Same intent ≠ same speech act.
- Same speech act ≠ same principle.
- Effect claim ≠ causal proof.
- Power ≠ legitimate authority.
- Meaning ≠ permission.
- Reflection ≠ origin.
- Similarity ≠ identity.
- Repetition ≠ corroboration.

## Research and verification caveat
This is an engineering proposal based on established distinctions in lexical semantics, pragmatics, speech-act theory, frame semantics, argumentation, provenance and governance. A Consensus literature synthesis could not be run because the connected account exhausted its monthly free usage until 1 December 2026. Do not mark this specification as peer-reviewed or academically verified until that review is completed.

## Implementation status
The semantic model and deterministic validation prototype are on the Phase 11 feature branch. It is not wired into the production Base44 agent runtime. Base44 schema, durable persistence, evidence adapters, multilingual evaluation data and UI integration remain separate integration tasks. No merge or deployment is performed.
