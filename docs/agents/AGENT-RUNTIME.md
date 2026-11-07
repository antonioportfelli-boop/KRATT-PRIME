# Agent Registry, Runtime and Factory Model
Status: Target design; agent count is not an implementation metric

## Initial roles
Master controller (task decomposition and routing, no policy override); Research; Engineering; Security; Integration; Design; QA.

## Registry fields
Agent ID/version, role, owner, enabled state, model/provider, allowed tools, repositories, branch/path scopes, data classification, budget, concurrency limit, timeout, retry policy, parent scope and audit identity.

## Lifecycle
REGISTERED → READY → RUNNING → WAITING/RETRYING → SUCCEEDED/FAILED/CANCELLED. Transitions are validated and audited. Cancellation and kill switch must fence active workers before side effects.

## Authority
Child scope is always a subset of parent scope. Tools are capabilities, not ambient permissions. Every tool call is checked against task, principal, connector and resource scope. Agent output is untrusted until validated.

## Scheduling and resilience
Use durable task IDs, leases with fencing tokens, bounded retries, deadlines, per-agent budgets and dead-letter handling. Do not retry irreversible operations without idempotency guarantees.

## Scaling
Start with a small number of specialist agents and measure success rate, error rate, latency, cost and recovery. Expand toward larger factory networks only when governance and operational capacity are demonstrated. The proposed 25 initial specialists and 149 eventual agents are planning concepts, not a deployed count.