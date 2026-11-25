# KRATT Authorized Construction Execution Orchestrator v1

Status: implementation on an isolated feature branch; tests authored, not executed.

## Scope

This module composes the execution ledger with the existing trusted authorization runtime and an injected authoritative lease coordinator. It is an orchestration boundary only: it does not create authority, verify evidence itself, provision keys, or implement a distributed lease service.

## Ordered execution protocol

1. Validate the existing KRATT task envelope and derive its canonical task digest.
2. Create the deterministic execution record and persist revision 0 before lease acquisition.
3. Acquire a lease from the trusted lease coordinator.
4. Evaluate policy through the trusted authorization runtime. Only an exact \`ALLOW\` proceeds.
5. Persist the claimed record using revision compare-and-append.
6. Persist the running record using revision compare-and-append.
7. Invoke the supplied executor only after all preceding gates succeed.
8. Validate the executor result digest, persist success/failure, then release the lease.

Every denied or failed pre-execution gate prevents the executor callback. The module never merges branches, pushes code, deploys, or performs an external write on its own.

## Required adapter contract

### Lease coordinator

- \`acquire({ execution_key, task_id, worker_id, ttl_ms })\` returns \`{ ok: true, claim }\`.
- Claim contains \`worker_id\`, \`lease_id\`, positive monotonic \`fence\`, and ISO expiry.
- \`release(claim)\` returns \`{ ok: true }\` only after release is confirmed.
- The coordinator is responsible for durable lease ownership, fencing across workers, renewal, expiry, and cancellation propagation. The ledger's local checks are not a distributed lease implementation.

### Revisioned ledger store

\`append({ execution_key, expected_revision, record })\` must atomically compare the stored revision and append exactly the next revision. The first write uses expected revision \`-1\` and record revision \`0\`. Later writes must advance by exactly one. The adapter must be durable and tamper-evident. The earlier idempotent \`appendExecutionRecord\` helper is for a single immutable record and must not be used as a multi-revision journal.

### Executor

The executor receives the validated task, execution key, claim, and trusted decision. It must independently honor capability scope, cancellation, and fencing before each side effect, and return a verified \`sha256:<64 hex>\` digest. A result digest is not evidence of success unless the trusted host independently verifies the referenced result.

## Security and failure semantics

- Authorization is evaluated after lease acquisition and before any executor call.
- Authorization decisions other than \`ALLOW\` fail closed.
- A failed initial intent write prevents lease acquisition.
- A failed running-state write prevents executor invocation.
- If the side effect may have completed but the final ledger write fails, the return value explicitly marks \`side_effect_may_have_completed\`; callers must reconcile, not blindly retry.
- Lease release failure is surfaced as \`lease_released: false\`; it is not reported as success.
- Approval nonce consumption may occur before a later persistence failure. This intentionally favors replay prevention over transparent retry; the operator must issue a fresh request-bound approval for a new attempt.

## Limitations

This version does not provide a concrete distributed lease backend, a production revisioned journal adapter, executor sandboxing, lease renewal, or end-to-end cancellation. The callback contracts must be implemented and tested against the chosen durable infrastructure before enabling side effects. This feature does not claim production readiness.

## Tests

The authored tests cover ordering, denial, lease acquisition failure, append failures, executor errors, result-digest validation, and missing adapter rejection. They have not been run in this session.
