# Wave 6 — Telegram Competitive Intelligence and Pricing Evidence

## Purpose

Convert Jason Bourne Telegram notifications into inspectable KRATT competitor observations. The Telegram message is an ingestion signal, not a trusted market fact. The new engine normalizes an already-parsed signal, validates its evidence references, invokes MÕTLEMINE, compares temporal claims against a previous snapshot, and calculates an explicitly assumption-bound monthly TCO estimate.

## Components

- `competitive-intelligence-engine.mjs`: strict signal envelope, source-verification gate, MÕTLEMINE bridge, temporal comparison and trusted-offer filter.
- `calculateMonthlyTco`: separate seat, flex-credit/action and conversation cost arithmetic; preserves currencies and excludes base CRM license costs.
- `competitive-intelligence-engine.test.mjs`: regression tests for baseline gaps, comparable pricing, unverified sources, entity scope and TCO.

## Signal lifecycle

1. Telegram adapter supplies channel/message identity and a parsed, normalized signal.
2. The caller injects `verifyTelegramSource`; no Telegram message is trusted merely because it arrived through the bot.
3. The signal carries KRATT evidence records. MÕTLEMINE only counts evidence accepted by its injected verifier.
4. A price change requires same competitor, SKU, currency, billing unit and region, plus an earlier comparable observation. A ranking change requires the same ranking universe and a prior ranking snapshot. A new entrant requires a stored prior competitor set.
5. If any required baseline is missing, the finding is `BASELINE_MISSING` or `INCOMPLETE_BASELINE_OR_EVIDENCE`, never a fabricated “0 changes”.
6. Only pricing observations attached to verified evidence enter the trusted pricing catalogue.

## Salesforce test case

The fixture must represent an as-of snapshot, not a claimed price change. Use separate rows for the USD and EUR catalogues; do not convert one into the other without an explicit FX source. The current official pricing page describes:
- Flex Credits by credit pack, with standard Agentforce Actions at 20 credits and Voice Actions at 30.
- Conversations on a per-conversation basis.
- A $5 / €5 Agentforce User License that requires Flex Credits.
- $125 / €125 user/month Agentforce add-ons with unmetered employee Agentforce usage.
- A $50 Coworker User License is shown on the US pricing page; do not infer a €50 SKU from that USD listing.
- Salesforce also documents Pre-Purchase, Pre-Commit and PayGo buying models. These are buying models, not five separate competitors or proof of a weekly price move.

Reference URLs:
- https://www.salesforce.com/agentforce/pricing/
- https://www.salesforce.com/eu/agentforce/pricing/

## Output and safety

The report includes source verification, MÕTLEMINE status/digest, comparison gaps, trusted/untrusted pricing observations, entity-reference warnings and weekly-change completeness. `policy_authority` is always false. It does not approve architecture, write to repositories, call providers, publish competitive claims or execute any action.

The TCO calculator estimates published variable usage at the per-unit rate. It does not model minimum pre-purchase blocks, negotiated discounts, taxes, base CRM licenses, contract commitments or overages. Results must be shown as estimates, not quotes.

## Production gates

- Implement Telegram API ingestion and durable snapshot persistence in the approved integration layer; this module intentionally receives normalized events and injects verification dependencies.
- Add an immutable snapshot repository and retention policy.
- Verify primary source URL/content digest independently; preserve source timestamps and captured page artifacts.
- Add authenticated admin review and approval before pricing/marketing claims are published.
- Add integration tests using real source snapshots and persistence; unit tests alone do not establish live Telegram, database or provider readiness.

## Baseline integrity and completeness

A supplied prior snapshot is eligible only when the caller marks it `verified: true`, its snapshot ID matches the signal, and the compared SKU, currency, billing unit, region and observation time are compatible. The marker is a contract with the trusted persistence adapter; it must never be populated from an untrusted Telegram payload.

Each monitored change category is complete only when every claim in that category is either evidence-backed as `CHANGE_CONFIRMED` or evidence-backed as `CLAIM_NOT_REPRODUCED`. A category with no claims, conflicting evidence, a mismatched snapshot or a missing baseline remains unassessed. When one category has a confirmed change and another has gaps, the aggregate is `CHANGES_CONFIRMED_WITH_GAPS`.
