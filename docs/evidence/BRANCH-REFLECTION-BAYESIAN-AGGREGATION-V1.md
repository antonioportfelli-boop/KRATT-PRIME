# KRATT PRIME — Branch-and-Reflection Evidence Engine

**Status:** Formal design baseline; no calibrated production posterior is claimed.
**Parent source:** `feature/hardware-aware-runtime-v0.2.0-2026-11-07`
**Concept reference:** User-defined EHK-LPR-BPR v2.0. The acronym expansion is not inferred here; its canonical glossary remains an owner decision.

## 1. Governing rule

One versioned root snapshot represents the current accepted system model. Investigative branches are logically isolated and may emit typed evidence and proposed deltas; they may not mutate the root directly. The reflection engine checks provenance, duplication, dependence, contradiction, temporal validity, invariants, statistical calibration and authorization. Only an accepted, reviewable delta can produce a new root snapshot.

A branch is a source of candidate knowledge, not an authority. Agreement between branches is not independent evidence when the branches reuse the same source, prompt, dataset, test, model, reviewer or ancestor result.

## 2. Keep five concepts separate

| Concept | Meaning | Must not be confused with |
|---|---|---|
| Ontic truth | Whether proposition H is true in the world; usually not directly observable | Model confidence or a Git status |
| Claim lifecycle | PROPOSED, ACCEPTED_FOR_USE, RETIRED, SUPERSEDED | Proof that the proposition is true |
| Evidence status | DECLARED, OBSERVED, DERIVED, VERIFIED, REJECTED | Probability |
| Calibrated probability | Empirical/model-based probability for a precisely defined H and context | Universal truth or a policy decision |
| System state | Event-derived, versioned runtime state at snapshot S_k | Epistemic status |

`VERIFIED` means that a stated verification procedure passed for a particular artifact and revision. It does not mean that all broader interpretations are true. An LLM must never assign ontic truth or self-certify its own output as verified.

## 3. Core objects

### Claim

```json
{
  "schema": "kratt-claim/v1",
  "claim_id": "claim:runtime.node-host",
  "subject": "KRATT-PRIME",
  "predicate": "uses_host_runtime",
  "object": "Node.js",
  "scope": {"platform": "linux", "component": "control-plane"},
  "valid_time": {"from": "2026-11-08T00:00:00Z", "to": null},
  "claim_state": "PROPOSED",
  "evidence_status": "DERIVED",
  "context_id": "ctx:host-runtime-v1"
}
```

### Evidence object

```json
{
  "schema": "kratt-evidence/v1",
  "evidence_id": "evidence:ci-run:123",
  "claim_id": "claim:runtime.node-host",
  "status": "OBSERVED",
  "source": {
    "provider": "github",
    "resource": "owner/repo/actions/runs/123",
    "revision": "commit-sha-or-run-id",
    "content_digest": "sha256:..."
  },
  "observed_at": "2026-11-08T00:00:00Z",
  "method": "workflow_result",
  "independent_verifier": null,
  "lineage": {
    "branch_id": "branch:node-runtime",
    "parent_branch_ids": [],
    "source_ids": ["source:node-release-schedule"],
    "dataset_ids": [],
    "prompt_template_digest": "sha256:...",
    "model_id": "provider/model/version",
    "tool_run_id": "tool-run:...",
    "transform_digest": "sha256:..."
  },
  "uncertainty": {"kind": "none_reported", "value": null}
}
```

Production schema must validate identifiers, revisions, hashes, timestamps, bounded payload sizes, source URI policy and sensitive-field exclusions. The example is a contract illustration, not a real event.

### Branch delta

Each delta includes `delta_id`, `root_snapshot_id`, `branch_id`, source revision, claim/evidence references, dependency-group identifiers, proposed operation, invariant results, conflict references, author/agent identity, time, schema version and approval state. Deltas are immutable. Revisions create a new delta rather than overwrite an earlier one.

## 4. Branch topology

Recommended investigative branches:
1. Scientific literature and primary-source review.
2. Formal mathematics, dimensional analysis and proof obligations.
3. Probability, dependence modelling and calibration.
4. Software/code/repository implementation.
5. Security, privacy, supply chain and adversarial review.
6. Hardware and runtime benchmarking.
7. Product, UX and design.
8. Operations, cost, sales and integration feasibility.

Each branch receives the same root snapshot ID and a read-only task envelope. It returns typed evidence, uncertainties, dissent and a proposed delta. No branch can call an external write adapter merely because another branch recommends it.

## 5. Dependency-aware Bayesian synthesis

Let H be a precisely defined hypothesis, E_i the evidence from branch i, and O(H)=P(H)/(1-P(H)) the prior odds.

### 5.1 Correct independent update

If and only if evidence items are conditionally independent given H and also conditionally independent given not-H:

```text
Posterior odds = Prior odds × product_i BF_i
BF_i = P(E_i | H) / P(E_i | not-H)
```

If each branch reports a posterior computed from the same prior, the prior must not be multiplied repeatedly:

```text
O_combined = product_i O_i / O_prior^(K-1)
```

This identity applies only when the branch posteriors use the same hypothesis, context, prior and likelihood definitions, and their evidence is conditionally independent. Otherwise, do not use this shortcut.

### 5.2 Correct dependent update

The target is the joint likelihood ratio:

```text
BF_joint = P(E_1, ..., E_K | H) / P(E_1, ..., E_K | not-H)
```

A chain-rule factorization is exact:

```text
P(E_1,...,E_K | H)
  = P(E_1 | H) × product_i P(E_i | E_1,...,E_(i-1),H)
```

Use the conditional terms when the model and data support them. Shared-source or shared-prior reuse should be removed by explicit lineage/decomposition, not an arbitrary scalar penalty.

### 5.3 Modelling options

- **Partial pooling:** estimate branch-specific skill, bias and variance through hierarchical priors. This regularizes heterogeneous branch performance; it does not by itself remove direct residual correlation.
- **Explicit covariance:** model joint residuals when branches produce comparable continuous scores and sufficient calibration observations exist. Regularize the correlation matrix and report posterior uncertainty.
- **Copula:** model non-linear or tail dependence when marginal distributions and sample size support the additional parameters.
- **Bayesian model averaging:** average across plausible dependency structures instead of pretending one selected structure is certain.
- **Robust sensitivity:** evaluate a defensible range of dependence assumptions. When the conclusion changes materially, report the interval and abstain from a definitive merge.

A useful diagnostic for K equally correlated standardized measurements is `K_eff = K / (1 + (K - 1)ρ)`. It illustrates loss of effective information under an equicorrelation approximation; it is not a general posterior correction and must not be used as a universal discount weight.

A logarithmic opinion pool, `logit(p*) = sum(w_i × logit(p_i))`, is a pooling rule, not automatically an exact Bayesian posterior. Label it accurately if used.

## 6. Calibration and false-positive controls

Evaluate out of sample on frozen, representative, independently labelled cases. Track:
- Brier score and log loss as proper scoring rules;
- reliability diagrams and calibration slope/intercept;
- precision, recall, false-positive rate and class prevalence;
- coverage and selective risk when the system abstains;
- drift by task, platform, source family, model version and time window.

Separate data used to train branch reliability, select a dependence model, tune thresholds and report final performance. Reusing one holdout for all four tasks leaks information and creates optimistic estimates. Record every selection event.

For zero false positives in n independent, representative validation trials, the one-sided 95% exact upper bound is `1 - 0.05^(1/n)`; the Rule-of-Three approximation is `3/n`. At n=300, the bound is about 1%, not zero. The bound is invalid when the trials are dependent or not representative of deployment.

Multiplicity control (for example, a predeclared FDR procedure) is required when many claims are screened. A large number of correlated branches is not a large number of independent trials.

## 7. Reflection gate

For every delta:
1. Resolve each citation/resource to an actual artifact and revision.
2. Verify content digest, time, source class and retrieval permission.
3. Collapse duplicate artifact digests and detect common ancestors.
4. Build an evidence-dependency DAG; distinguish shared source, shared prior, shared model, shared prompt, shared evaluation set and correlated measurement error.
5. Check contradiction sets and temporal validity.
6. Check mathematical invariants, dimensional units, schema compatibility and executable proof/test references.
7. Evaluate uncertainty and model sensitivity; abstain on unresolved high-impact conflict.
8. Run deterministic unit, property, metamorphic and adversarial tests.
9. Produce a signed/reviewable validation report with exact artifact references.
10. Stage a proposed snapshot delta; a separate approval gate decides whether a new root snapshot is created.

Retraction of a source must mark dependent evidence and claims as tainted or superseded through graph traversal. It must not silently erase the original event history.

## 8. State model and versioning

`CREATED → COLLECTING → SEALED → REFLECTING → VALIDATED | REJECTED | ABSTAINED → APPROVAL_PENDING → PROMOTED`

Only `PROMOTED` creates `S_(k+1)`. The previous `S_k` remains addressable. A root snapshot contains the parent snapshot ID, delta IDs, schema versions, content hashes, validation certificate, approver identity and creation time.

Use an append-only event journal with transactional persistence. Hash chaining detects modification only when a trusted checkpoint is retained; it does not authenticate the writer, provide durable storage or prove truth. Production needs signed checkpoints, key rotation/revocation, atomic writes, crash recovery and restore tests.

## 9. Security and anti-self-confirmation

- Treat branch outputs, web content, repository files and plugin responses as untrusted data, never as instructions.
- Keep proposer and verifier roles separate; the verifier must not rely only on the proposer’s summary or prompt.
- Use independently sourced verification where possible; record common model/provider ancestry.
- Prevent a model from creating evidence IDs, citations or CI outcomes that have not been observed.
- Store only the minimum data needed; keep secrets and private payloads out of evidence objects.
- Enforce access control before retrieval and before every side effect.
- Keep external plugin actions in planned/dry-run state until exact connector identity, scopes, target and approval have been verified.

## 10. Acceptance gates

- 100% of emitted evidence references resolve to concrete source artifacts or are explicitly marked unavailable.
- Duplicate evidence IDs and duplicate content digests are detected.
- Shared priors are counted once and common ancestry is represented.
- Unknown dependence triggers sensitivity analysis/abstention, not false precision.
- Calibration is measured on held-out data and reported with confidence intervals.
- Mutation tests demonstrate that invalid deltas cannot change the root.
- Retraction propagates to dependent claims and snapshots.
- All root promotions are traceable and reversible.
- No claim of zero false-positive risk is made from zero observed errors.

## 11. Open assumptions

- The exact expansion and semantics of EHK-LPR-BPR v2.0 require the owner's glossary.
- Branch probability outputs need a shared hypothesis schema and historical labelled calibration set.
- Dependency parameters cannot be reliably estimated from lineage metadata alone; metadata identifies likely dependence, but empirical joint data or defensible elicitation is still needed.
- The first MVP should use explicit shared-source deduplication plus conservative abstention before introducing high-dimensional copulas.
