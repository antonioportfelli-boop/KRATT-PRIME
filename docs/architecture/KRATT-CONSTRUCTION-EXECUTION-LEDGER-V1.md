# KRATT Construction Execution Ledger v1

Status: isolated implementation on `feature/kratt-construction-execution-ledger-v1`.

## Why this layer exists

The construction protocol models review and verification; the reflection journal persists reflection outcomes. This module introduces a separate execution record to make an individual construction operation traceable across claim, run, retry, completion, and cancellation.

It does not replace the durable worker lease coordinator, authorization hardening, provenance verifier, or PrimeStore. Those remain authoritative at their respective boundaries.

## Contract

- Stable execution identity is derived from task ID, task revision, task digest, and operation name.
- Lifecycle: `QUEUED → CLAIMED → RUNNING → SUCCEEDED`, with explicit `RETRY_WAIT`, `FAILED`, and `CANCELLED` paths.
- A claim includes worker ID, lease ID, monotonically increasing fencing token, and expiry.
- Start, completion, and failure require the exact active claim and a non-expired lease.
- The fencing token is supplied by the authoritative lease coordinator. This module checks its monotonicity within a record; it does not itself coordinate distributed leases.
- Records are canonicalized and SHA-256 digested. Every state transition increments a revision and appends an immutable event.
- Persistence uses an injected store adapter with `open`, `put`, `readAll`, and `verify`.
- Duplicate writes are accepted only when the persisted record digest matches exactly.
- Recovery verifies the complete journal and validates each record. It never resumes, replays, or dispatches work.

## Security boundaries

This module is intentionally not an authorization mechanism. A valid execution record does not confer permission to call tools, write repositories, execute commands, or deploy. The host must independently validate authorization, evidence provenance, task scope, lease ownership, cancellation, and policy before any side effect.

The store adapter must provide atomic idempotency for a given key and cryptographically meaningful journal verification. The in-memory test adapter is not a production persistence implementation.

## Validation

The test suite covers deterministic IDs, valid lifecycle transitions, fencing/claim mismatches, expiry, retry exhaustion, terminal failure, cancellation, tamper detection, idempotent persistence, journal verification, and conflicting duplicate payloads.

Execution status: tests are authored in this PR. This connector session does not provide a local Node.js runtime or Actions workflow-dispatch action, so no test pass or CI run is claimed.
