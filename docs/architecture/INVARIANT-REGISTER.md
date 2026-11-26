# WP-04 — Invariant Register

Date: 2026-11-27  
Scope: KRATT PRIME mainline plus explicitly identified feature-branch evidence. This register distinguishes mainline enforcement from candidate implementations in open Draft PRs.

## Status semantics

- **DESIGNED** — documented, but no authoritative enforcement mechanism is established.
- **PARTIALLY ENFORCED** — a local or policy-level guard exists, but the full system guarantee is incomplete.
- **ENFORCED** — the authoritative runtime or persistence boundary enforces the rule.
- **TESTED** — named tests exercise the behavior; this does not imply staging or live verification.
- **VERIFIED** — independently verified in the target integration environment.
- **NOT IMPLEMENTED** — no implementation was found in the reviewed scope.

No entry is marked VERIFIED because no staging or live integration was exercised in this audit.

## Source baselines

- KRATT PRIME main: 782373cd7760a12141c75655dd890313c30f3021.
- WP-04.1: 26000aae9c94aa81a67fd75ed05840119d0e2b06; Draft PR #62.
- WP-04.2: f5bde5bb85c30284dff374b5fbf06099b21b66b5; Draft PR #63.
- WP-04.3: feature/wp-04-3-capability-authorization-binding-2026-11-27 (candidate; CI pending at document creation).
- WP-03.8/.9 remain separate Draft branches and are not on main.
- STEEL main: 1da5fd84d9ebb0a796326e3453d052ca73bc7650.

## Register

| ID | Required invariant | Enforcement point and evidence | Status |
|---|---|---|---|
| INV-IDENTITY-001 | Adapter ID must resolve to a trusted subject and pinned source identity. | WP-04.2 exact source/revision/path binding, byte digest and host provenance receipt. | PARTIALLY ENFORCED |
| INV-AUTH-001 | External WRITE requires verified request-bound approval. | WP-01 approval verifier; WP-04.3 binds principal, agent, provider, operation, target, scopes and request digest. | PARTIALLY ENFORCED |
| INV-AUTH-002 | Authorization is current at effect boundary. | WP-03.9 worker fence is branch-only; WP-04.3 returns a short-lived decision but not an effect-bound recheck. | PARTIALLY ENFORCED |
| INV-AUTH-003 | Missing, expired, revoked, conflicting or malformed context fails closed. | Existing policy primitives plus WP-04.3 adversarial tests. | TESTED |
| INV-AUTH-004 | Effective rights are the intersection of principal, agent and integration grants. | WP-04.3 host context loader plus intersectEffectiveScopes; all three inputs are mandatory. | PARTIALLY ENFORCED |
| INV-AUTH-005 | A signed approval must bind the exact canonical request payload digest. | WP-04.3 adds requestDigest to the normalized signed approval envelope and rejects missing/mismatched values. | TESTED |
| INV-AUDIT-001 | Security decisions must have append-only evidence. | WP-04.3 appends a minimal decision record before returning an authorization grant; production store still injected. | PARTIALLY ENFORCED |
| INV-ADAPTER-003 | Registration is bound to immutable repository, commit, path and independently checked artifact bytes. | WP-04.2 exact source/digest verification and provenance receipt. | PARTIALLY ENFORCED |
| INV-ADAPTER-004 | Read-only promotion needs independent conformance and atomic state/audit change. | WP-04.2 CAS lifecycle path; concrete production store unimplemented. | PARTIALLY ENFORCED |
| INV-ADAPTER-005 | Adapter operation can receive only declared, versioned capabilities within host-issued principal/agent/integration grants. | WP-04.3 operation resolution, versioned capability refs and scope intersection. | PARTIALLY ENFORCED |
| INV-ADAPTER-006 | Approval replay cannot produce a second grant. | WP-04.3 requires a verifier-produced approval and one-time ledger consume; production ledger is host supplied. | PARTIALLY ENFORCED |
| INV-TENANT-001 | Tenant data, credentials and audit records cannot cross tenant boundaries. | Canonical tenant identity/storage enforcement remains unimplemented. | NOT IMPLEMENTED |
| INV-EXEC-001 | Authorization grant is request-digest-bound, short-lived and unforgeable by object shape. | WP-04.3 WeakSet-branded decision with exact digest and bounded read lifetime. | TESTED |

## Qualification

WP-04.1, WP-04.2 and WP-04.3 are Draft feature work, not mainline or live integrations. No status is VERIFIED. The production registration store, trusted verifiers, durable nonce ledger, audit backend, tenant isolation and provider-specific behavior remain external acceptance gates.
