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
- WP-03.8: feature/wp-03-8-receiver-dedup-2026-11-26 at b34dd369fbfbbbfc425ecb8da762f3c9721a0e9d; Draft PR #60.
- WP-03.9: feature/wp-03-9-provider-worker-security-2026-11-26 at 98ec935c25f220f5c0e7b4f4a35eaeb989753b8e; Draft PR #61.
- WP-04.1: feature/wp-04-adapter-contract-foundation-2026-11-27 at 26000aae9c94aa81a67fd75ed05840119d0e2b06; Draft PR #62.
- WP-04.2: feature/wp-04-2-host-registration-provenance-2026-11-27 (this candidate branch; CI evidence pending at document creation).
- STEEL main: 1da5fd84d9ebb0a796326e3453d052ca73bc7650.

## Register

| ID | Required invariant | Enforcement point and test evidence | Recovery / violation behavior | Status |
|---|---|---|---|---|
| INV-IDENTITY-001 | Adapter/node identity must resolve to a trusted subject and a pinned source identity; an adapter ID string alone is not identity. | WP-03 trust registry binds node, repository, source revision and key lifecycle. Evidence: PostgreSQL trust-registry and integration tests on WP-03.9. WP-04.2 adds source/artifact binding at host registration, subject to an independently trusted verifier. | Reject unknown, disabled, revision-drifted or revoked identities; operator-controlled re-registration is required. | PARTIALLY ENFORCED |
| INV-AUTH-001 | An external WRITE requires a cryptographically verified, request-bound approval. | Mainline policy.mjs and approval-evidence.mjs provide request-bound approval primitives; authorized-dispatch tests cover denial paths. WP-04.2 never grants WRITE. | Deny before intent or dispatch; obtain a fresh approval rather than reusing a stale artifact. | PARTIALLY ENFORCED |
| INV-AUTH-002 | Authorization must be current at the effect boundary; reservation-time policy evidence is not a permanent permission. | WP-03.9 revalidates policy revision, trust identity, cancellation and delivery-start fences in PostgreSQL transactions; branch-specific tests only. | Stop before provider call; if delivery has already started and result is unknown, reconcile without blind retry. | TESTED |
| INV-AUTH-003 | Missing, expired, revoked, conflicting or malformed authorization context fails closed. | Mainline policy and trusted-runtime primitives plus WP-03 dispatch denial tests. | Preserve intent and denial evidence; no automatic privilege escalation or fallback. | TESTED |
| INV-FABRIC-001 | Inbound Fabric events must be validated, digest-checked and authenticated against the exact source identity/key. | WP-03 Fabric ingress and persisted trust registry; PostgreSQL integration and pinned-contract tests on WP-03 feature branches. | Reject malformed, expired, replay-conflicting or unauthenticated events before handler execution. | TESTED |
| INV-FABRIC-002 | Fabric policy must bind source, destination, event type, scope, source revision and policy revision. | WP-03 trust registry and receiver transaction revalidation; branch-specific tests cover policy revision mismatch and trust mutation serialization. | Reject or quarantine; never infer missing identity or silently widen scope. | TESTED |
| INV-ACK-001 | An ACK is accepted only when its signature and exact event, digest, receiver identity, policy revision and delivery attempt match durable state. | WP-03.8/.9 ACK stores and Ed25519 verification; PostgreSQL CI on exact branch heads. | Reject invalid ACK; retain the unresolved outbox record for reconciliation. | TESTED |
| INV-ACK-002 | A late or duplicate ACK cannot reverse a terminal cancellation or create a second side effect. | WP-03.9 late-ACK ledger and terminal-state transaction; integration tests on that feature branch. | Persist late evidence separately; preserve cancellation/terminal state. | TESTED |
| INV-OUTBOX-001 | Intent, outbox reservation, immutable event and associated audit evidence must be transactionally consistent. | WP-03 outbound PostgreSQL stores and migrations; integration tests on WP-03 feature branches. | Transaction rollback leaves no partial successful dispatch; commit ambiguity is resolved from durable records. | TESTED |
| INV-OUTBOX-002 | Delivery requires the current owner, exact lease token and an unexpired database-time fence. | WP-03.9 outbox store and worker; owner mismatch, expiry and cancellation integration tests. | Reject stale worker; expired-after-start becomes RECONCILE, not resend. | TESTED |
| INV-IDEMPOTENCY-001 | Same scope, idempotency key and content digest resolve to the same durable intent/result without re-running the handler. | WP-03.8 receiver receipt/ACK replay and WP-03.9 outbound reservation tests. | Return the persisted receipt/ACK or result; do not re-execute. | TESTED |
| INV-IDEMPOTENCY-002 | Reuse of an idempotency key with different content or scope is a conflict. | WP-03 receiver digest-conflict and outbound reservation binding tests. | Reject the conflict and preserve the original immutable record. | TESTED |
| INV-AUDIT-001 | Security-critical state changes have durable, append-only audit evidence. | WP-03 stores and append-only database guards; WP-04.2 defines atomic record-plus-audit store methods, with an in-memory test double only. | Fail the transaction when required audit persistence fails; reconcile ambiguous writes before retry. | PARTIALLY ENFORCED |
| INV-AUDIT-002 | Audit-chain tampering must be detectable. | WP-03 hash-chain checks; independent external checkpointing and restricted database roles remain unverified. | Stop trust-sensitive writes and initiate independent audit/backup reconciliation. | PARTIALLY ENFORCED |
| INV-TENANT-001 | A request, adapter, outbox record, ACK, audit entry and credential reference cannot cross tenant boundaries. | No canonical tenant-scope enforcement was established in the reviewed KRATT core and WP-03 contract paths. | Deny cross-tenant operations until tenant identity is bound and independently enforced at persistence boundaries. | NOT IMPLEMENTED |
| INV-ADAPTER-001 | Discovery or a valid contract declaration is not permission to load or execute an adapter. | WP-04.1 validates closed declarations and exact versions. WP-04.2 registers metadata only after exact source bytes, digest and host verifier evidence; it exposes no loader or execution function. | Keep adapter non-executable until a separately reviewed execution/isolation gate exists. | PARTIALLY ENFORCED |
| INV-ADAPTER-002 | An adapter cannot register itself as trusted, grant itself capabilities or enable WRITE. | WP-04.2 host API accepts only a manifest plus actor reference, requires injected provenance/conformance verifiers, and offers no enableWrite or execution method. Verifier and persistence trust roots remain host-owned and unverified here. | Reject self-asserted trust or grants; remain CONNECTED_UNVERIFIED unless independent read-only conformance succeeds. | PARTIALLY ENFORCED |
| INV-ADAPTER-003 | Registration is bound to immutable repository, commit, source path and independently checked artifact bytes. | WP-04.2 source reader must return exact manifest coordinates; runtime recomputes SHA-256 and requires a host provenance receipt. Adversarial unit tests added. | Reject source drift, digest mismatch, missing verifier evidence or stale revision. | PARTIALLY ENFORCED |
| INV-ADAPTER-004 | Read-only promotion requires independent conformance evidence and an atomic lifecycle/audit update. | WP-04.2 calls the existing lifecycle transition, checks a revision before and after verification, and uses compareAndSwapWithAudit. The concrete production store is not implemented in this slice. | Do not promote on failed verifier, stale revision or store/audit failure. | PARTIALLY ENFORCED |
| INV-RECOVERY-001 | An unknown external outcome cannot become success or be blindly retried. | WP-03.9 moves unknown outcomes to RECONCILE; worker and PostgreSQL tests cover timeout, stale lease and late ACK paths. | Preserve intent and evidence; reconcile provider state before another side effect. | TESTED |
| INV-OBSERVABILITY-001 | Operational metrics and diagnostics must not expose secrets or unbounded identity/resource labels. | WP-03.9 defines bounded Fabric telemetry; WP-04.2 audit projections contain identifiers and digests only, not raw source bytes, credentials or arbitrary payloads. | Drop or suppress telemetry that violates the schema; telemetry failure must not change authorization or transaction results. | PARTIALLY ENFORCED |

## Important qualifications

- WP-03.8 and WP-03.9 are tested on their feature branches and remain open Draft PRs. Their guarantees are not on main or live unless separately merged and deployed.
- WP-04.1 is an open Draft PR. Its current head had successful Node 22 contract/typecheck/build workflows.
- WP-04.2 is a feature-branch candidate. Its unit/CI evidence must be tied to the exact current head; no staging or live integration is claimed.
- No row is VERIFIED. Tenant isolation, production credential custody, external audit anchoring, provider-specific idempotency and a live STEEL receiver remain explicit gaps.
