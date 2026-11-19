# Semantic retrieval evaluation v1

**Status:** evaluator implemented; semantic memory activation remains disabled.

## Purpose

Evaluate whether a future semantic retriever returns relevant, source-backed evidence within the caller's authorized scope. The evaluator is intentionally separate from storage, embedding generation and policy. It accepts query digests, relevance labels and retrieved evidence references; it does not accept or persist raw query text.

## Inputs

- Dataset query: stable queryId, queryDigest, scopeId and one or more labelled relevant evidence references.
- Retrieval result: one bounded ordered list of evidence references for each query.
- Evidence verifier: caller-supplied function backed by the authoritative evidence ledger or repository. It must verify both ground-truth labels and retrieved results.
- A fixed evaluation clock for deterministic timestamp checks.

Each evidence reference binds evidenceId, sourceId, artifactDigest, observedAt and scopeId. A reference outside the query scope is excluded and counted as a scope violation. An unverified reference is never counted as relevant.

## Metrics

- Precision@k and recall@k (macro-averaged across queries).
- Mean reciprocal rank (MRR).
- Normalized discounted cumulative gain at k (nDCG@k).
- Query coverage with at least one verified result.
- Unverified, duplicate and scope-violation counts/rates.
- Dataset, retrieval and evaluation SHA-256 digests for repeatability.

Unverified and out-of-scope results retain their original ranking positions for scoring, so invalid high-ranked results cannot be hidden by filtering them out first.

## Shadow gate

assessSemanticShadowEligibility requires explicit query-count, precision, recall, MRR, coverage and contamination thresholds. Passing yields SHADOW_ELIGIBLE only. It does not grant storage write permission, authorize truth promotion, enable production indexing or dispatch any action.

## Future work still required

A real vector/search adapter, index versioning and rebuilds, freshness policy, tenant/principal filtering, retention/deletion, query privacy controls, representative labelled datasets, reviewer adjudication and retriever-vs-keyword baselines. No semantic-memory feature should be described as active until those pieces are independently implemented and measured.
