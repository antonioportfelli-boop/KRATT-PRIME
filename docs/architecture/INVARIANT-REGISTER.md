# WP-04 — Invariant Register

Date: 2026-11-27  
Scope: KRATT PRIME mainline plus explicitly identified WP-04 feature evidence. No production/staging integration was exercised by these branches.

## Status semantics

- **DESIGNED** — documented only.
- **PARTIALLY ENFORCED** — local guard exists, but full deployment guarantee is incomplete.
- **TESTED** — named automated tests exercise the behavior; not a live verification.
- **NOT IMPLEMENTED** — no implementation in reviewed scope.
- **VERIFIED** — independently verified in target environment. No WP-04 row is VERIFIED.

## Source baselines

- KRATT PRIME main: 782373cd7760a12141c75655dd890313c30f3021.
- WP-04.1: 26000aae9c94aa81a67fd75ed05840119d0e2b06; Draft PR #62.
- WP-04.2: f5bde5bb85c30284dff374b5fbf06099b21b66b5; Draft PR #63.
- WP-04.3: 85832de60f0f2292c622e645e4a0e12bf3fc9e02; Draft PR #64 candidate.
- WP-04.4: feature/wp-04-4-process-isolated-adapter-context-2026-11-27; candidate, CI pending.
- WP-03.8/.9 remain separate Draft branches, not mainline.
- STEEL main: 1da5fd84d9ebb0a796326e3453d052ca73bc7650.

## Register

| ID | Invariant | Enforcement / evidence | Status |
|---|---|---|---|
| INV-IDENTITY-001 | Adapter identity binds immutable source identity. | WP-04.2 exact repository/commit/path, recomputed artifact digest, host provenance verifier. | PARTIALLY ENFORCED |
| INV-AUTH-001 | WRITE requires verified request-bound approval. | WP-01 verifier + WP-04.3 principal/agent/provider/operation/target/scope/requestDigest binding. | PARTIALLY ENFORCED |
| INV-AUTH-002 | Authorization is current at effect boundary. | WP-03.9 worker fences remain branch-only; WP-04.4 adds injected immediate pre-start and post-execution fence. | PARTIALLY ENFORCED |
| INV-AUTH-003 | Missing, expired, revoked, conflicting or malformed context fails closed. | WP-01 and WP-04.3 tests. | TESTED |
| INV-AUTH-004 | Effective rights equal principal ∩ agent ∩ integration grants. | WP-04.3 host context loader and scope intersection. | PARTIALLY ENFORCED |
| INV-AUTH-005 | Signed approval binds exact request digest. | WP-04.3 canonical requestDigest in normalized signed payload. | TESTED |
| INV-AUDIT-001 | Security decisions/execution boundaries append durable audit evidence. | WP-04.2–04.4 define atomic store interfaces; concrete production stores remain external. | PARTIALLY ENFORCED |
| INV-ADAPTER-003 | Registration binds immutable repo/commit/path and independently checked artifact bytes. | WP-04.2 registration provenance gate. | PARTIALLY ENFORCED |
| INV-ADAPTER-004 | Read-only promotion requires independent conformance and atomic lifecycle/audit change. | WP-04.2 CAS and audit interface. | PARTIALLY ENFORCED |
| INV-ADAPTER-005 | Operations use only declared, versioned capabilities within trusted grants. | WP-04.3 manifest resolution plus three-way scope intersection. | PARTIALLY ENFORCED |
| INV-ADAPTER-006 | Approval replay cannot produce a second grant. | WP-04.3 verifier-branded object plus one-time ledger consume; production ledger external. | PARTIALLY ENFORCED |
| INV-EXEC-001 | Grant is unforgeable by object shape, digest-bound and short-lived. | WP-04.3 module-branded authorization grant with requestDigest and expiry. | TESTED |
| INV-EXEC-002 | Only an independently attested OS process/container may run adapter code. | WP-04.4 requires PROCESS_ISOLATED, verified supervisor policy, allowlisted network, restricted filesystem and no raw secrets. Actual supervisor not supplied. | PARTIALLY ENFORCED |
| INV-EXEC-003 | Registration/policy/cancellation are rechecked before worker launch. | WP-04.4 compares registration revision/digests and calls injected execution fence. | PARTIALLY ENFORCED |
| INV-EXEC-004 | Unknown worker outcome cannot be reported success or blindly retried. | WP-04.4 validates closed worker result and records UNKNOWN state. | TESTED |
| INV-TENANT-001 | Tenant data, credentials and audit records cannot cross tenant boundaries. | Canonical tenant ID and tenant-scoped storage are not implemented. | NOT IMPLEMENTED |

## Qualification

WP-04.1–WP-04.4 are feature candidates and Draft PRs, not merged mainline capabilities or live deployments. No row is VERIFIED. Concrete production registration, decision, replay and execution stores; trusted verifier/key lifecycle; OS process/container supervisor; credential broker; tenant isolation; and live provider conformance remain release gates.
