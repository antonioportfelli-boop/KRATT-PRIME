# SIPA-11 Runtime Integration

## Current implementation boundary

The SIPA-11 runtime is implemented as a decorator around KRATT PRIME's existing authorized dispatcher. It deliberately does not reproduce authorization, principal authentication, one-time nonce storage, idempotency, or durable command-intent behavior.

~~~text
Request
  -> trusted semantic-context loader
  -> Talmud preflight
  -> Meridian chain verification + preflight append
  -> existing authorized dispatch runtime
       -> principal authentication
       -> task contract validation
       -> trusted policy + evidence + request-bound approval
       -> durable intent / idempotency claim
       -> provider adapter
  -> independent postflight evidence loader
  -> Anti-Talmud comparison
  -> Meridian postflight append
  -> PASS / or QUARANTINE + correction proposal
~~~

## Composition contracts

Use the existing authorization/dispatch composition root and pass it into the SIPA-11 guarded dispatch runtime.

- dispatchRuntime.execute(request): the existing KRATT authorized dispatcher. It remains the only component allowed to reach provider adapters.
- loadSemanticContext(request): returns source, proposed, sourceReference, sourceVersion, and independently sourced booleans for provenance, evidence, authority scope, conflict resolution, source version, and freshness.
- loadIndependentPostflight({ request, dispatchResult, semanticContext }): returns observed, independentEvidenceVerified, and optional finding metadata. It must not echo the preflight verdict as its evidence.
- meridianStore.append(node) and meridianStore.verify(): durable, append-only evidence-chain adapter. The runtime verifies the chain after every append. The in-memory test adapter is only a test fixture.
- correctionStore.propose(proposal): optional durable proposal queue. It may store a proposal, but must not apply it or grant approval.

## Semantic rules

The comparator preserves subject, scope, effect, authority, power, freshness, provenance, negation, temporal, principle, meaning, influence, word content, language context, jurisdiction, purpose, conditions, and prohibited equivalences. Modality includes both strength and polarity; MUST cannot become SHOULD, and MUST cannot become MUST_NOT without a finding.

Unknown fields, accessors, sparse arrays, cycles, non-finite numbers, and unsupported prototypes fail closed in canonical comparison.

A Polymorphosis round trip may be classified as preserved or loss-review-required. Declared loss of authority, power, scope, or effect blocks release.

## Failure handling

- Preflight failure: no call to the existing dispatcher.
- Meridian unavailable or unverifiable: no dispatch.
- Dispatch throws: outcome is reported as unknown; do not assume the side effect did not happen.
- Independent postflight unavailable: quarantine the result.
- Semantic divergence after dispatch: quarantine the result, append a finding, create a non-applicable correction proposal. This does not reverse an already completed provider action.
- Echo restoration requires restored and verified Meridian, a separate approval, invariant verification, matching constitution version, and verified round trip.

## Verification

The new source and tests are included in the feature branch. CI is the authoritative test/build check. The project CI executes:

~~~sh
node --test packages/kratt-core/test/*.test.mjs packages/kratt-orchestrator/test/*.test.mjs
npm run typecheck
npm run build
~~~

The five integration families and their 25 bidirectional sub-contracts in SIPA-11-MIRROR-CONTRACTS.md remain integration specifications. This branch does not claim that provider accounts, external endpoints, or production persistence adapters have been connected.
