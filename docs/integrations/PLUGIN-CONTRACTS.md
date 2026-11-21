# Plugin Gateway and Adapter Contracts
Status: Target contract

## Capability manifest
Each plugin declares plugin ID/version, publisher, purpose, supported operations, input/output schemas, required capabilities, data classifications, network destinations, timeout, rate limit, idempotency behavior and support status.

## Invocation envelope
Include request ID, task ID, principal, agent ID, plugin ID/version, operation, canonical target, deadline, idempotency key, policy decision reference and trace ID.

## Execution rules
Validate manifest and schemas before invocation. Authorize every operation through KRATT policy. Apply least-privilege capability scopes and destination allowlists. Treat plugin output as untrusted; validate and attach provenance. Enforce deadlines, quotas, concurrency and cancellation. Record intent, result and error with redaction. Do not expose secrets to plugins unless a narrowly scoped credential broker explicitly authorizes it.

## Lifecycle
DISCOVERED → REVIEWED → APPROVED → ENABLED → SUSPENDED/REVOKED. New or changed plugin versions require re-review. No automatic installation or permission expansion.

## Conformance tests
Schema rejection, scope denial, malicious output, prompt injection, timeout, retry/idempotency, cancellation, secret redaction and audit completeness.