# KRATT PRIME Wave 5 — Async Trusted Authorization

## Purpose

Bridge the Wave 3 policy/Ed25519 approval boundary to the Wave 4 PostgreSQL transactional outbox without consuming an approval nonce before the durable command transaction. This is the server-side async composition root:

1. Authenticate the session and bind principal ID to \`task.actor\`.
2. Validate the task envelope.
3. Load trusted policy context and evidence from server-owned loaders.
4. Verify every evidence record with the configured trusted evidence verifier.
5. Evaluate the existing KRATT policy engine.
6. For approval-required actions, verify the Ed25519 signature, key identity, approver, authority, expiry, request digest and complete request binding **without consuming the nonce**.
7. Derive the idempotency key from the canonical task digest.
8. In one PostgreSQL transaction, consume the approval nonce (when required), serialize task cancellation, claim the idempotency key, insert the intent, enqueue the outbox record, and append the audit event.
9. Return \`QUEUED\`. The request path never calls a provider.

The transaction is the point at which the verified approval nonce is consumed. A failed insert, cancellation conflict, duplicate key or audit/outbox error rolls the transaction back.

## Components

- \`packages/kratt-core/src/async-trusted-runtime.mjs\` — Wave 5 server composition root; trusted keyring and pure signature verification followed by one transactional store call.
- \`packages/kratt-core/src/policy.mjs\` — \`createRequestBoundApprovalSignatureVerifier\` verifies request binding and signature age but deliberately does not consume a nonce. The existing synchronous verifier remains available for Wave 3 compatibility.
- \`packages/kratt-core/src/postgres-outbox-store.mjs\` — validates the task envelope and recomputes the canonical idempotency key before reservation; supports approval-required and non-approval tasks; writes denial audit records.
- \`packages/kratt-core/src/outbox-worker.mjs\` — dispatches claimed queue records using the stable idempotency key, bounded retries and dead-letter state.
- \`packages/kratt-core/src/steel-factory-protocol-adapter.mjs\` — strict STEEL Factory Protocol v1 envelope/receipt adapter.
- \`packages/kratt-core/src/motlemine-engine.mjs\` — deterministic reasoning report over verified evidence, independent sources, dependencies and contradictions.

## Approval and nonce semantics

The new async runtime has a different composition contract from \`createTrustedAuthorizationRuntime\`. The latter consumes a nonce synchronously inside policy evaluation and therefore cannot be combined with a later async database transaction as one atomic operation. Wave 5 instead calls the pure signature verifier during \`evaluatePolicy\` and passes only the derived key ID, nonce, approval ID, expiry, request digest and signature digest to the PostgreSQL reservation call.

The caller must never expose the raw nonce-claim path to untrusted input. Trusted approval keys come from server-controlled configuration. The PG store re-validates claim shape and request digest, and uses a unique \`(key_id, nonce)\` constraint.

For policies that do not require approval, the transaction skips the nonce insert but still reserves the idempotent intent and outbox row.

## Concurrency and recovery

Reservation and cancellation acquire the same transaction-scoped advisory lock keyed by task ID. This serializes a cancellation request with a reservation for the same task. The outbox worker uses \`FOR UPDATE SKIP LOCKED\`, lease tokens and expiry; a crashed worker's lease can be reclaimed.

Delivery is at-least-once. A provider may complete an operation and the worker may crash before recording its result. Every adapter must enforce the stable idempotency key and support reconciliation. Do not treat provider execution as exactly once.

## STEEL Factory Protocol v1 adapter

The adapter validates the closed \`TaskEnvelope\` and \`ActionReceipt\` shapes from STEEL \`factory/protocol/types.ts\`. It maps only a caller-selected action that appears in \`allowed_actions\`, is absent from \`forbidden_actions\`, and is restricted to a subset of the envelope's declared scope.

STEEL evidence tokens are mapped through an explicit \`evidenceClaimMap\`; no silent vocabulary conversion occurs. The action receipt must bind task, agent, repository, base SHA, action and scope. Even when its \`verification_state\` says \`VERIFIED\`, the adapter still requires the injected \`verifyActionReceipt\` callback to independently verify the receipt. The opaque \`evidence\` property is not itself accepted as trusted KRATT evidence.

This repository change adds the adapter in KRATT PRIME. It does not write to the STEEL organization repository.

## MÕTLEMINE v1

MÕTLEMINE is a deterministic evidence-reflection engine, not a generative model and not an authorization policy. It:
- accepts structured claims and explicit \`SUPPORTS\` / \`REFUTES\` assessments;
- counts only evidence records accepted by an injected trusted verifier;
- counts independent \`(source_type, source_id)\` pairs rather than raw evidence rows;
- flags conflicting support/refutation and dependency cycles;
- blocks dependent claims when prerequisite claims are not supported;
- emits reason codes, evidence IDs, source counts and a SHA-256 report digest.

The assessor-supplied stance is preserved as an assessment, not asserted as a fact. The report always sets \`policy_authority: false\`.

## Verification status and remaining production gate

Unit and mocked SQL-contract tests cover the transaction call sequence, rollback branches, signature tampering, policy denial, evidence failure, STEEL scope binding, MÕTLEMINE independence/contradiction logic, and queue-only behavior.

No PostgreSQL server or credentials were available in this execution. The mocked pool tests are not a substitute for a real PostgreSQL integration run. Before production:
- run the migration and tests against the supported PostgreSQL major version;
- test concurrent reservation/cancellation, duplicate nonce, duplicate idempotency, lease expiry, worker crash after provider success, and dead-letter recovery;
- configure DB TLS, least-privilege roles, backups, monitoring and external audit hash checkpoints;
- supply reviewed provider adapters with idempotency and reconciliation;
- wire the outbox worker into a supervised process only after the above evidence exists.

No production database, provider adapter, credential, deployment or external write is enabled by this increment.
