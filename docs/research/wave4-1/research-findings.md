# Wave 4.1 research findings

Date: 2026-11-27  
Scope: KRATT PRIME authorization, runtime telemetry, worker coordination, storage, and measured throughput.

## 1. Zero-trust decision boundary

**Source:** NIST SP 800-207, Zero Trust Architecture  
https://csrc.nist.gov/pubs/sp/800/207/final

NIST frames zero trust around protecting resources rather than trusting network location or ownership. Authentication and authorization are distinct functions before access to a resource is established.

**Adoption decision:** retain request-bound policy evaluation at the execution boundary. A provider connection, task fingerprint, local network, adapter registration, or prior successful request does not confer authorization. Every external write remains bound to the current task, trusted context, evidence, approval signature, nonce, scope, expiry, cancellation, and durable intent.

**Security consequence:** telemetry can explain and measure a decision, but cannot grant, revoke, or change authority. An unknown or stale security state remains fail-closed.

## 2. Security event coverage and log protection

**Source:** OWASP ASVS 5.0, V16.3 Security Events and V16.4 Log Protection  
https://owasp.org/projects/ASVS

ASVS 5.0 includes successful and failed authentication events, failed authorization attempts, defined security events, control-bypass attempts, and unexpected security-control failures. It also requires log-injection protection and protection against unauthorized access or modification.

**Adoption decision:** retain an allow-listed, bounded-cardinality operational telemetry surface and a separate authoritative durable decision/outcome journal. Do not move authorization decisions into the telemetry sink. Do not include raw task payloads, evidence bodies, credentials, tokens, or personal information in operational events. The existing telemetry ring is a bounded diagnostic buffer, not the durable audit system.

**Remaining verification:** test event coverage at the governed-runtime, worker-lease, queue/outbox, and evidence-provenance boundaries. A successful dispatch-path integration does not yet prove end-to-end event coverage.

## 3. Events versus durations

**Source:** OpenTelemetry Semantic Conventions — Events and Traces  
https://opentelemetry.io/docs/specs/semconv/general/events/  
https://opentelemetry.io/docs/specs/semconv/general/trace/

OpenTelemetry models named state changes and point-in-time outcomes as events. Operations with meaningful duration are better represented as spans; durations and point-in-time events should not be conflated.

**Adoption decision:**
- Keep `authorization.allowed`, `authorization.denied`, `dispatch.intent_committed`, `dispatch.completed`, `dispatch.failed`, `dispatch.cancelled`, `queue.rejected`, `lease.fenced`, and `evidence.verification_failed` as named, bounded events.
- Measure task validation, policy evaluation, persistence, provider execution, queue wait, lease acquisition, and end-to-end completion as duration observations or spans.
- Carry one validated correlation identifier through the whole operation.
- Keep high-cardinality task IDs and correlation IDs out of metric labels; use them only in individual event/trace context where retention and privacy policy allow.

## 4. Node.js measurement and concurrency

**Sources:**
- Node.js Performance Hooks: https://nodejs.org/api/perf_hooks.html
- Node.js Worker Threads: https://nodejs.org/api/worker_threads.html
- Node.js AbortController / AbortSignal: https://nodejs.org/api/globals.html

Node's performance APIs provide high-resolution timing and event-loop delay histograms. Event-loop delay is timer-sampled; a benchmark must allow the loop to run so the sampler can observe delays. CPU time and heap/RSS are separate resource dimensions and should be recorded with the same workload.

Worker threads are appropriate to investigate for CPU-bound JavaScript work, not as a default solution for I/O-bound tasks. Any adoption must account for structured-clone/transfer cost, worker startup, bounded worker count, cancellation, failure, memory limits, and a validated task boundary. The current benchmark is Node 22 compatible; it does not depend on newer runtime-only event-loop sampling features.

AbortSignal can communicate cancellation to supported asynchronous operations. It is not by itself proof that a remote side effect was rolled back. The durable execution state, worker acknowledgement, idempotency, and fencing controls remain authoritative.

**Adoption decision:** first measure the real dispatch path and repeated-round variance. Do not introduce Worker Threads, an async pool, or a new queue before their overhead and security boundaries are measured.

## 5. PostgreSQL queue claiming and lease time

**Sources:**
- PostgreSQL 18 SELECT / locking clauses: https://www.postgresql.org/docs/18/sql-select.html
- PostgreSQL 18 date/time functions: https://www.postgresql.org/docs/18/functions-datetime.html
- PostgreSQL 18 transaction isolation: https://www.postgresql.org/docs/18/transaction-iso.html

PostgreSQL documents `FOR UPDATE SKIP LOCKED` as suitable for queue-like consumers that should avoid contention. It deliberately returns an inconsistent view and is not a general-purpose consistency mechanism. Row locking and the subsequent state transition must be part of a transaction with a well-defined commit boundary.

PostgreSQL's `now()` / `CURRENT_TIMESTAMP` represent transaction start time. `clock_timestamp()` returns actual wall-clock time and changes during statement execution. A lease expiry check that must evaluate the current lease at the time of completion should not accidentally compare against a stale transaction-start timestamp.

**Adoption decision:** retain a single database transaction for nonce reservation, idempotency reservation, intent/outbox creation, and the authoritative audit entry. Claim work using row-level locking or an equivalent atomic conditional update. Fence completion and retry by both the lease token and a live server-time expiry predicate. The branch change in `098f8e2` moves outbox completion/retry checks to `clock_timestamp()`.

**Critical limitation:** the repository contains a PostgreSQL outbox adapter and contract/static tests, but no confirmed live PostgreSQL integration run or multi-process race test. Do not claim cross-process or multi-host guarantees until a real PostgreSQL instance, migrations, independent processes, crash/restart, duplicate dispatch, expiry, and stale-worker completion have been exercised.

## 6. Current adoption decisions

| Area | Decision | Evidence required before wider adoption |
|---|---|---|
| Security event model | Keep allow-listed operational events separate from durable audit | Governed-runtime, queue, lease, cancellation and evidence failure tests |
| Event duration | Measure durations separately from event names | Repeated-round benchmark and low-cardinality aggregation |
| Worker threads | Defer | CPU profile showing CPU-bound JS bottleneck, plus bounded worker/cancel tests |
| Evidence indexing | Defer until multi-requirement benchmark demonstrates scan cost | Equivalence tests for every evidence, duplicate ID, revision and verifier invocation |
| PostgreSQL outbox | Keep existing adapter; do not duplicate | Live PostgreSQL integration and independent-process race/recovery tests |
| Retry/backpressure | Preserve existing bounded retry semantics | Capacity, saturation, retry exhaustion and crash recovery tests |
| eBPF/XDP | Read-only synthetic diagnostic only | Kernel compatibility, packet coverage, ring-loss and resource tests in isolated Linux CI |

## 7. Benchmark interpretation

The first end-to-end CI run is a **smoke baseline**, not a controlled performance comparison. It uses a temporary local SQLite database with WAL and `synchronous=FULL`, real Ed25519 approval/evidence verification, and a mocked provider. It does not exercise PostgreSQL, queue admission, the runtime worker lease, cancellation, crash recovery, multi-process coordination, or real network latency.

No performance improvement is claimed until repeated rounds are run under comparable hardware/runtime conditions and the security regression suite remains green.
