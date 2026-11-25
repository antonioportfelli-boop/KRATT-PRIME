# KRATT Governed Execution Bridge v1

Status: draft implementation on `feature/kratt-governed-execution-bridge-v1`.

## Purpose

Connect four existing KRATT PRIME capabilities without creating parallel policy, evidence, or lease implementations:

1. WP-01 trusted authorization and request-bound Ed25519 approval verification.
2. Durable Evidence Cards (ECK) with PrimeStore journal integrity and a host-side provenance verifier.
3. Durable worker lease coordination with monotonically increasing fencing tokens.
4. Construction Execution Ledger with immutable, append-only execution revisions.

The bridge is a gated workflow composition root. It is not a general-purpose autonomous worker and does not dispatch repository writes, provider calls, deployments, or arbitrary tools.

## Flow

### 1. Bind task intent

The caller supplies:
- an authenticated principal (credential material is resolved by the host);
- a validated KRATT task envelope;
- an immutable construction task with verifiable history and `APPROVED` state;
- a request-bound signed approval when policy requires one.

The bridge binds the KRATT task ID to the construction task ID, the builder to the authenticated principal, the requested path to the construction task's target scope, and the policy-task digest to the construction-task digest. Path traversal, malformed task history, and identity mismatch fail closed.

### 2. Verify durable evidence

The bridge reads a stable snapshot from `DurableEvidenceRepository`:
- verify the PrimeStore journal and ECK projection;
- read every page within a configured bound;
- verify the journal head did not change during the read;
- accept only ECK cards with `decision=VERIFIED`, target-root binding, branch binding when supplied, artifact digest, source reference, and exact `kratt-policy-evidence/v1` metadata;
- map the ECK card into the existing WP-01 evidence contract;
- call the trusted host's `verifyEvidenceProvenance` callback for each candidate.

The callback must establish the evidence source and artifact authenticity. A matching schema or digest by itself is not proof of provenance. Any invalid candidate carrying policy-evidence metadata blocks the request; the bridge does not silently ignore malformed policy evidence.

### 3. Evaluate WP-01 authorization

The bridge passes the validated task, mapped evidence and trusted context to the existing `authorizationRuntime.evaluate`. The runtime is expected to validate policy scope, trusted authorities, evidence, request-bound approval signature, expiry, nonce consumption, and kill-switch state.

Only `ALLOW` proceeds. Missing, invalid, stale, conflicted, or untrusted inputs stop before lease acquisition.

### 4. Acquire fenced lease and persist execution claim

The bridge derives a stable execution key from task identity, revision, combined digest, and operation. It:
- confirms the supplied execution snapshot is the latest persisted revision;
- acquires a lease through the existing `createWorkerLeaseCoordinator`;
- translates the coordinator's monotonically increasing fence into an execution claim;
- appends the new execution-ledger revision;
- records a governance receipt binding the authorization decision, evidence-card digests, ECK journal heads, task digests, context digest, principal, and lease fence.

If claim persistence or receipt persistence fails, the bridge attempts a fenced compensating release and reports the failure. The PrimeStore journal is shared among evidence, lease, execution and governance receipt records; writers must use the existing single-process/store coordination assumptions.

### 5. Start gate

Before a claimed workflow can enter `RUNNING`, the bridge rechecks:
- authenticated principal and task/construction binding;
- trusted context freshness, expiry and kill-switch;
- current lease owner, fence and expiry;
- governance receipt integrity and binding;
- the same ECK cards and content digests used by authorization;
- a stable, verified ECK journal snapshot.

A successful `start` updates workflow state only. It reports `dispatch=false` and `externalEffects=false`. An actual worker/side-effect adapter is intentionally not implemented here.

### 6. Completion, failure and cancellation

Completion and failure require the active unexpired lease and exact claim. They append a new immutable execution revision and release the lease through the coordinator.

Retry is explicit. A retry requires:
- previous state `RETRY_WAIT`;
- a current WP-01 `ALLOW` decision and any fresh request-bound approval required by policy;
- a newly acquired lease with a strictly higher fence;
- a new append-only execution revision.

Cancellation of queued/claimed/retry-wait work is recorded. Cancellation of `RUNNING` work requires a host-provided worker acknowledgement callback before terminal state is persisted. A lease release alone is not treated as proof that a running worker stopped.

### 7. Recovery

Recovery verifies the whole PrimeStore journal, validates every execution revision, rejects gaps/forks/conflicting payloads and returns only the latest valid revision per execution key.

Recovery never resumes or replays a worker. `RUNNING` executions after a crash require operator/worker reconciliation; this bridge deliberately does not infer that a side effect did or did not happen.

## Trust boundaries and non-goals

- The authentication callback must resolve an authenticated principal from trusted server context. The bridge does not authenticate raw credentials.
- The authorization runtime and its trusted keyring/nonce store must be deployment-controlled. Test-only in-memory nonce stores are not production dependencies.
- The provenance callback must verify source authenticity; the ECK digest is only integrity linkage.
- The lease coordinator is local/single-process. Its fencing value must also be enforced at every eventual side-effect target. This bridge does not claim cross-host mutual exclusion.
- PrimeStore is a local append-only journal, not encrypted storage and not cloud synchronization. Protect its directory with OS access controls.
- Governance receipt + lease + execution-ledger writes are not one multi-record database transaction. Compensating lease release is attempted; failures are surfaced for reconciliation.
- No provider, repository, deployment, external-write, or arbitrary tool execution is performed.
- No exactly-once side-effect guarantee is claimed.

## Validation

`packages/kratt-core/test/governed-execution.test.mjs` exercises:
- signed request-bound approval and trusted policy ALLOW;
- verified ECK evidence/provenance;
- lease acquisition and fencing;
- claim/start/complete and verified recovery;
- missing approval and rejected evidence provenance;
- kill-switch rejection before lease acquisition;
- lease expiry before start;
- retry with a higher fencing token.

Tests are authored but have not yet been executed in this editing session. The draft PR is intended to trigger repository CI; merge and deployment are out of scope.
