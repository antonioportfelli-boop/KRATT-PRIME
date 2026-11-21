# KRATT PRIME — €50,000 Productisation Plan
**Version:** 1.0  
**Date:** 2026-11-10  
**Status:** ACTIVE PRODUCT BUILD PLAN — NON-PRODUCTION  
**Working branch:** `feature/kratt-prime-50k-productization-v1`

## 1. Product decision

**Product name:** KRATT PRIME Signal-to-Evidence  
**Category:** Evidence intelligence and decision-assurance workspace  
**One-line promise:** Turn fragmented news and channel signals into traceable claims, independently reviewable evidence, contradiction alerts, and human-approved intelligence briefs.

KRATT PRIME is not positioned as a generic chatbot or an autonomous decision-maker. Its commercial advantage must be a verifiable evidence trail: where a claim came from, what supports or contradicts it, what has been checked, who approved the conclusion, and which version of the evidence was used.

### Initial customer wedge
Start with small competitive-intelligence, research, media-monitoring, and risk-analysis teams that currently combine Telegram, news feeds, browser research, spreadsheets, and manual brief writing.

### First paid outcome
A customer can import a set of links or a structured feed, inspect normalized claims and evidence cards, see duplicates and contradictions, review source provenance, and export a human-approved brief with citations and an audit trail.

Do not initially promise:
- unattended Telegram ingestion or complete social-platform coverage;
- factual truth guarantees or fully automated verification;
- autonomous financial, legal, medical, or operational decisions;
- production-grade multi-tenant security until it has been tested independently.

## 2. €50,000 minimum valuation target

The target is a **defensible enterprise value (EV) of at least €50,000**, not a guaranteed asking price and not the current value of the code.

### Conservative operating hurdle
Use a deliberately discounted internal planning multiple of **2.0× ARR** to account for early scale, product risk, customer concentration, and founder dependence.

| Metric | Minimum target |
|---|---:|
| Recurring monthly revenue (MRR) | €2,083 |
| Recurring annual revenue (ARR) | €25,000 |
| Planning multiple | 2.0× ARR |
| Implied enterprise value | €50,000 |
| Paying customers | 5 independent customers |
| Average recurring contract | €417/month |
| Retention evidence | At least 90 days per pilot cohort |
| Revenue quality | Subscription revenue only; exclude one-off setup fees |

Example: 5 customers × €420/month × 12 = €25,200 ARR; at the internal 2.0× planning hurdle this implies €50,400 EV. This is a target scenario, not a market quotation or promise that a buyer will pay that amount.

### Market reference — not a KRATT valuation
The 2026 market material reviewed for this plan reports private SaaS M&A median EV/Revenue of 3.1× in Q1 2026; Aventis reports a 3.3× median for deals below $5M across its historical transaction sample. Those samples are materially larger and more mature than KRATT PRIME, so this plan applies a lower 2.0× internal hurdle rather than borrowing the headline median. See:
- Aventis Advisors, *SaaS Valuation Multiples: 2015–2026*, published 31 Aug 2026: https://aventis-advisors.com/saas-valuation-multiples/
- Array Capital, *B2B SaaS valuation multiples: 2021 to 2026*, updated 30 Jul 2026: https://www.arraycapital.com/insights/saas-valuation-multiples/

### Two separate asset ledgers
1. **Reusable IP / replacement cost:** engineering artefacts, tested modules, architecture, documentation, and rights. The prior preliminary audit estimated €4,000–€10,000 risk-adjusted reusable IP value and €10,000–€24,000 replacement cost. These were modelled estimates, not an independent appraisal.
2. **Commercial enterprise value:** recurring revenue, customer contracts, gross margin, retention, transferability, and buyer demand. The €50,000 target is to be demonstrated primarily through this ledger.

Never add replacement cost and ARR-derived enterprise value together. They measure different things and doing so would double-count value.

## 3. Product scope — first sellable version

### Included in V1
- Local/manual import of URLs and structured JSON/CSV/RSS items.
- Source registry with source URL, publisher, observed time, ingestion time, capture method, and content digest.
- Normalized signal records and claim records with stable identifiers.
- Evidence cards with provenance, supporting material, counter-evidence, status, and reviewer.
- Duplicate clustering and explicit contradiction detection.
- Evidence integrity checks: schema validation, digest recomputation, and rejection of altered or untrusted cards.
- Human review queue and explicit approval state.
- Citation-backed intelligence brief export.
- Append-only local audit journal with replay/integrity verification.
- Clear status labels: UNREVIEWED, UNDER_REVIEW, SUPPORTED, CONTESTED, REJECTED, APPROVED.
- Local-first mode and documented data retention controls.

### Deferred until the V1 proof passes
- Telegram live polling/webhooks and additional network adapters.
- Multi-user cloud tenancy, billing automation, and enterprise SSO.
- Autonomous agent actions or outbound publishing.
- Advanced calibrated Bayesian scoring, until calibration artefacts can be independently verified.
- Production deployment and public launch.

## 4. Product architecture and boundaries

| Layer | Responsibility | Release gate |
|---|---|---|
| Ingestion adapters | Import RSS, URLs, JSON/CSV; later Telegram | Every imported item has provenance |
| Normalization | Stable IDs, timestamps, canonical source fields | Deterministic tests |
| Evidence kernel | Claims, cards, links, digests, integrity | Tamper and schema tests pass |
| Reflection engine | Support/contradiction analysis | No caller-supplied boolean treated as proof |
| Review workflow | Human decisions, expiry, approval, cancellation | Fail-closed authorisation |
| Brief generator | Reproducible report with source references | Every factual claim traceable |
| Storage | Local durable journal and replay | Crash/replay and hash-chain tests |
| UI / API | Review queue, search, exports | Accessibility and security checks |

**Product identity rule:** AURA remains a separate visualizer product. STEEL and FRAME.9 remain separate product identities. KRATT PRIME owns its evidence-intelligence product scope; no root-level rebranding or replacement of AURA is authorised by this plan.

**Repository rule:** The inspected `main` branch currently identifies its root app as AURA (`trinitywayve-aura`). The runtime candidate exists on a materially divergent feature branch. This work branch therefore starts from `main` and contains product documentation only. Runtime code must be ported or integrated only after a canonical KRATT code source and commit-level reconciliation are established.

## 5. Value-creation work packages

### WP-A — Source of truth and clean IP boundaries
- Declare canonical KRATT runtime source and product ownership.
- Inventory third-party dependencies, licences, provenance, and original contributions.
- Keep AURA, STEEL, FRAME.9 separate.
- Record all branch ancestry and port only reviewed commits; do not merge the 58-ahead/77-behind candidate wholesale.

**Exit evidence:** signed-off repository map, dependency/licence inventory, reproducible commit map.

### WP-B — Evidence integrity and reflection correctness
- Recompute and verify evidence-card digests at every trust boundary.
- Replace caller-provided `passed: true` invariant flags with executable, versioned checks and provenance.
- Fix delimiter-based conflict parsing; use structured claim/decision keys.
- Verify any calibration artefact against a trusted registry; otherwise label the score experimental.
- Preserve fail-closed trusted time and request-bound approval.

**Exit evidence:** negative and positive tests, tamper tests, conflict tests, trusted-clock tests, reviewable test logs.

### WP-C — First complete vertical slice
- Import 20–100 sample source items.
- Normalize sources and claims.
- Create evidence cards and link counter-evidence.
- Surface duplicates and contradictions.
- Produce a cited brief.
- Store an audit event for each consequential review action.

**Exit evidence:** repeatable demo dataset, deterministic outputs, end-to-end test, demo recording or screenshots.

### WP-D — Security and operational readiness
- Threat model, secrets scan, dependency and licence review.
- Access control, retention/deletion, export controls, tenant boundaries.
- Backup/restore and incident-response runbook.
- Independent security review before customer data is accepted.

**Exit evidence:** signed security checklist and resolved critical/high findings.

### WP-E — Paid design partners
- Recruit 5 teams in the initial customer wedge.
- Run a scoped pilot with customer-approved sample data.
- Measure time saved, source traceability, analyst review time, false-positive rate, and repeat usage.
- Convert pilots to recurring subscriptions.

**Exit evidence:** signed pilot agreements, invoices, paid renewals, customer references with permission, usage and retention metrics.

### WP-F — Transferability and buyer diligence
- Document deployment, support, onboarding, and change management.
- Prepare clean financial records, recurring revenue ledger, customer concentration, churn, gross margin, IP assignment, and licence schedule.
- Demonstrate that delivery does not depend entirely on the founder.

**Exit evidence:** buyer-ready data room and independent valuation review.

## 6. Pricing hypotheses for validation

These are test prices, not approved market facts.

| Package | Hypothesis | Included |
|---|---:|---|
| Analyst | €249/month | 1 seat, bounded monthly imports, evidence cards, cited exports |
| Team | €699/month | 5 seats, shared review queue, source collections, audit history |
| Research | €1,250/month | 10 seats, priority onboarding, custom source schema, export/API allowance |
| Paid pilot | €1,500–€3,000 fixed | 2–4 week bounded workflow proof; separate from ARR |

Do not count pilot/setup fees as ARR. Set exact import caps, retention, support, and data-processing terms before billing.

## 7. Acceptance gates

A feature is not complete because it exists in a branch. It is complete only when:
1. Its requirement and failure modes are documented.
2. Tests cover success, denial, malformed input, tampering, and cancellation where relevant.
3. The test command, environment, commit SHA, and exit code are recorded.
4. Data provenance is retained and outputs are reproducible.
5. No secrets or customer personal data are committed.
6. The reviewer can inspect the evidence without trusting the author’s assertion.

## 8. Execution sequence

1. Lock product boundary and canonical source (WP-A).
2. Repair evidence integrity, reflection, conflict parsing, and clock policy (WP-B).
3. Deliver local import-to-cited-brief vertical slice (WP-C).
4. Complete threat model and operational checks (WP-D).
5. Run paid design-partner pilots and prove retention (WP-E).
6. Prepare transferability pack and independently assess €50k+ (WP-F).

**Do not deploy to production, publish, merge into `main`, change permissions, or close existing Draft PRs as part of this plan.**

## 9. Current status at plan creation

- A separate feature branch was created from `main`.
- This branch is a non-production productisation workstream.
- No runtime source code has been merged or changed by this plan.
- No tests, typecheck, build, security scan, or customer pilot are claimed as completed.
- The next implementation task is WP-A/WP-B source reconciliation and testable evidence-integrity repair in the canonical KRATT runtime source.
