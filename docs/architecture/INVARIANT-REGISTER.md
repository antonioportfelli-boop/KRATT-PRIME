# WP-04 — Invariant Register

Date: 2026-11-27  
Scope: KRATT PRIME mainline plus explicitly identified WP-03 feature-branch evidence.  
This register distinguishes implementation on main from implementation that exists only in an open Draft PR.

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
- STEEL main: 1da5fd84d9ebb0a796326e3453d052ca73bc7650.

## Register

| ID | Required invariant | Enforcement point and test evidence | Recovery / violation behavior | Status |
|---|---|---|---|---|
| INV-IDENTITY-001 | Adapter/node identity must resolve to a trusted subject and a pinned source identity; an adapter ID string alone is not identity. | WP-03 trust registry binds node, repository, source revision and key lifecycle. Evidence: postgres-fabric-trust-registry.mjs and postgres-fabric-trust.integration.test.mjs on WP-03.9. | Reject unknown, disabled, revision-drifted or revoked identities; operator-controlled re-registration is required. | TESTED |
| INV-AUTH-001 | An external WRITE requires a cryptographically verified, request-bound approval. | Mainline policy.mjs and approval-evidence.mjs provide request-bound approval verification; authorized-dispatch tests cover denial paths. | Deny before intent or dispatch; obtain a fresh approval rather than reusing a stale artifact. | PARTIALLY ENFORCED |
| INV-AUTH-002 | Authorization must be current at the effect boundary; reservation-time policy evidence is not a permanent permission. | WP-03.9 revalidates policy revision, trust identity, cancellation and delivery-start fences in PostgreSQL transactions. | Stop before provider call; if delivery has already started and result is unknown, reconcile without blind retry. | TESTED |
| INV-AUTH-003 | Missing, expired, revoked, conflicting or malformed authorization context fails closed. | Mainline policy and trusted-runtime primitives plus WP-03.9 worker/dispatch denial tests. | Preserve intent and denial evidence; no automatic privilege escalation or fallback. | TESTED |
| INV-FABRIC-001 | Inbound Fabric events must be validated, digest-checked and authenticated against the exact source identity/key. | WP-03 Fabric ingress and persisted trust registry; PostgreSQL integration and pinned-contract tests on the WP-03 branch. | Reject malformed, expired, replay-conflicting or unauthenticated events before handler execution. | TESTED |
| INV-FABRIC-002 | Fabric policy must bind source, destination, event type, scope, source revision and policy revision. | WP-03 trust registry and receiver transaction revalidation; tests cover policy revision mismatch and trust mutation serialization. | Reject or quarantine; never infer missing identity or silently widen scope. | TESTED |
| INV-ACK-001 | An ACK is accepted only when its signature and exact event, digest, receiver identity, policy revision and delivery attempt match durable state. | WP-03.8/03.9 ACK stores and Ed25519 verification; PostgreSQL 16 CI on exact WP-03.9 SHA. | Reject invalid ACK; retain the unresolved outbox record for reconciliation. | TESTED |
| INV-ACK-002 | A late or duplicate ACK cannot reverse a terminal cancellation or create a second side effect. | WP-03.9 late-ACK ledger and terminal-state transaction; postgres-fabric-ack and delivery E2E integration tests. | Persist late evidence separately; preserve cancellation/terminal state. | TESTED |
| INV-OUTBOX-001 | Intent, outbox reservation, immutable event and associated audit evidence must be transactionally consistent. | WP-03 outbound PostgreSQL stores and migrations 0004–0009; delivery integration tests. | Transaction rollback leaves no partial successful dispatch; commit ambiguity is resolved from durable records. | TESTED |
| INV-OUTBOX-002 | Delivery requires the current owner, exact lease token and an unexpired database-time fence. | WP-03.9 postgres-outbox-store.mjs and outbox-worker.mjs; owner mismatch, expiry and cancellation integration tests. | Reject stale worker; expired-after-start becomes RECONCILE, not resend. | TESTED |
| INV-IDEMPOTENCY-001 | Same scope, idempotency key and content digest resolve to the same durable intent/result without re-running the handler. | WP-03.8 receiver receipt/ACK replay and WP-03.9 outbound reservation tests. | Return the persisted receipt/ACK or result; do not re-execute. | TESTED |
| INV-IDEMPOTENCY-002 | Reuse of an idempotency key with different content or scope is a conflict. | WP-03 receiver digest-conflict and outbound reservation binding tests. | Reject the conflict and preserve the original immutable record. | TESTED |
| INV-AUDIT-001 | Security-critical state changes have durable, append-only audit evidence. | WP-03 trust registry, ACK/outbox transactions and append-only database guards. | Fail the transaction when required audit persistence fails; require operator reconciliation if external delivery already began. | TESTED |
| INV-AUDIT-002 | Audit-chain tampering must be detectable. | WP-03 hash-chain checks and trust-audit tamper-detection integration coverage. External checkpointing and restricted database roles remain unverified. | Stop trust-sensitive writes and initiate independent audit/backup reconciliation. | PARTIALLY ENFORCED |
| INV-TENANT-001 | A request, adapter, outbox record, ACK, audit entry and credential reference cannot cross tenant boundaries. | No canonical tenant-scope enforcement was established in the reviewed KRATT core and WP-03 contract paths. | Deny cross-tenant operations until tenant identity is bound and independently enforced at persistence boundaries. | NOT IMPLEMENTED |
| INV-ADAPTER-001 | Discovery or a valid contract declaration is not permission to load or execute an adapter. | WP-04 adapter-contract.mjs validates declarations and exact versions only; it intentionally exposes no loader or execution function. Runtime registration remains future WP-04 work. | Keep adapter non-executable until separate trust registration, provenance and runtime gates exist. | PARTIALLY ENFORCED |
| INV-ADAPTER-002 | An adapter cannot register itself as trusted, grant itself capabilities or enable WRITE. | Existing integration-capability-registry.mjs is a policy primitive; lifecycle and authorization authority still belong to the host. No complete runtime registration authority was found. | Reject self-asserted trust and WRITE state; require a separate host-controlled state transition and approval. | PARTIALLY ENFORCED |
| INV-RECOVERY-001 | An unknown external outcome cannot become success or be blindly retried. | WP-03.9 moves unknown outcomes to RECONCILE; worker and PostgreSQL tests cover timeout, stale lease and late ACK paths. | Preserve intent and evidence; reconcile provider state before another side effect. | TESTED |
| INV-OBSERVABILITY-001 | Operational metrics and diagnostics must not expose secrets or unbounded identity/resource labels. | WP-03.9 fixed allowlist Fabric counters/gauges and tests verify label-free metrics and sink-failure isolation. | Drop or suppress telemetry that violates the schema; telemetry failure must not change authorization or transaction results. | TESTED |

## Important qualification

WP-03.8 and WP-03.9 are tested on their feature branches and remain open Draft PRs. Their status does not mean the guarantees are present on main or active in a live environment. Tenant isolation, provider-specific idempotency, external audit anchoring, real credential custody and a live STEEL receiver remain explicit gaps.
