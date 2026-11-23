# CHIRO-X / PIP — KRATT PRIME integration

## Purpose

CHIRO-X adds a controlled multimodal interpretation capability to KRATT PRIME.
Its reusable core contract is the Pattern Interpretation Protocol (PIP).

The design deliberately separates:

1. **Observation** — measurable visual, textual, audio, or structural features.
2. **Source claim** — a statement attributed to a named, retrievable source.
3. **Hypothesis** — a possible interpretation that is not promoted to fact.
4. **Validation** — a separate trusted verification result.

A model-generated interpretation cannot mark itself as supported. A configured,
independent verifier must return a supported status and confirm the source
references. Symbolic hypotheses cannot be promoted to factual source claims.

## Current implementation

- \`src/pip-contracts.mjs\`: strict PIP bundle, observation, privacy, interpretation,
  and event validation.
- \`src/chiro-x.mjs\`: least-privilege agent registration, trusted interpretation
  review gate, surface-divergence detection, typed events, and Saga adapter.
- \`test/chiro-x.test.mjs\`: regression tests for contracts, consent, references,
  trusted verification, agent scopes, event envelopes, and Saga transitions.

No new runtime dependencies are introduced. Existing KRATT contracts,
policy evaluation, AgentRegistry, and Saga state machine remain unchanged.

## Runtime composition

- **STEEL / Trinity Edge**: capture and local preprocessing; strip EXIF metadata.
- **AURA**: select a replaceable vision or language-model provider.
- **GOLIATH OS**: orchestrate the analysis Saga and agent tasks.
- **CHIRO-VISION**: produce observations only.
- **CHIRO-INTERPRETER**: propose source claims and hypotheses.
- **KRATT**: validate evidence and provenance.
- **Talmud Engine**: perform pre-interpretation semantic checks.
- **Anti-Talmud Engine / CHIRO-SKEPTIC**: identify unsupported leaps, conflicts,
  and false certainty after interpretation.
- **PANDORA**: run benchmark and regression cases.

## Privacy and use restrictions

- PIP bundles carry metadata, not raw image bytes.
- Consent is mandatory.
- Remote processing requires separate remote-processing approval.
- Raw input retention requires separate retention approval.
- Model-training use is a separate explicit opt-in.
- Do not implement palmprint identity matching or biometric identification.
- Do not infer health, lifespan, personality, employability, creditworthiness,
  or future events from palm images.
- Chiromancy material is labelled as historical/cultural tradition or hypothesis,
  not scientific evidence about an individual.

## Evaluation

Recommended initial benchmark measures:

- feature-detection precision/recall against human-labelled samples;
- confidence calibration for visual detection;
- source-reference coverage;
- unsupported-claim rate;
- contradiction-detection recall;
- abstention quality on low-quality or ambiguous inputs;
- privacy-policy violation count.

Model agreement is not truth. The current divergence detector measures
surface-level statement variation for identical evidence groups and flags it
for human review; it does not calculate semantic truth or consensus.

## Run tests

From the repository root:

\`\`\`bash
npm test
npm run typecheck
npm run build
\`\`\`

These commands must be run in the repository's supported Node 22 environment.


## Phase 11 provider pipeline

\`src/chiro-phase11-pipeline.mjs\` implements the Phase 11
\`semanticPipeline.run(input)\` contract. Pass its result as the
\`semanticPipeline\` option to \`createPhase11Runtime\`.

AURA supplies interchangeable adapters:

- \`visionProvider.extractObservations({ assetRef, sessionId, processingMode, privacy, correlationId })\`
- \`interpretationProvider.proposeInterpretations({ sessionId, domain, observations, correlationId })\`

A trusted synchronous \`verifyInterpretation\` function is injected separately.
The vision provider receives an opaque asset reference, not image bytes in the
PIP request. The pipeline checks explicit consent before either provider runs.
It emits metadata-only CHIRO events and uses the existing Saga state machine.

This is a provider-neutral integration seam; no OpenAI, xAI, or other external
provider credentials or SDKs are embedded in the core package.
