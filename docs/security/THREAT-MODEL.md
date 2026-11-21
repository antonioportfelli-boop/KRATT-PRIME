# KRATT PRIME Threat Model
Status: Initial threat model — requires engineering/security review

## Assets
User and organization data; credentials and signing keys; approval artifacts and policy; agent queues and memory; repositories and external systems; audit evidence and execution outcomes.

## Threat actors and failure sources
Malicious or compromised user/agent; prompt injection in files/web/issues/tool output; compromised adapter/provider; stale or forged evidence; replay and duplicate delivery; concurrent or stale workers; misconfigured policy/key registry; storage corruption and clock drift; accidental privilege escalation.

## Threats and required controls
| Threat | Required control |
|---|---|
| Forged VERIFIED evidence | Independent trusted verifier; never trust caller enum |
| Approval replay | Atomic durable nonce consumption and expiry |
| Approval substitution | Canonical signed payload bound to exact task/actor/provider/operation/target |
| Scope escalation | Intersection of inherited scopes; deny empty/ambiguous scope |
| Path traversal | Canonical path normalization and allowlisted roots |
| Stale worker execution | Lease token/fencing check immediately before side effect |
| Duplicate webhook | Durable inbox uniqueness and end-to-end idempotency |
| Kill-switch bypass | Central check immediately before dispatch |
| Memory tampering | Append-only events, integrity verification and protected backups |
| Prompt injection | Treat retrieved content as data, not instructions; capability isolation |
| Secret leakage | Secret scanning, redaction and least-privilege access |
| CI false confidence | Distinguish blocked, failed, passed and not-run statuses |

## Mandatory invariants
Fail closed when trust dependencies are missing. No side effect without fresh policy decision. Approval is exact-operation and exact-target bound. Agent authority cannot exceed inherited-scope intersection. Every side effect has an idempotency key and durable audit trail. Cancellation and kill switch override prior authorization. Secrets never enter logs, fixtures, PR descriptions or generated documentation.

## Residual risks
Key custody/rotation, production database topology, independent evidence sources, incident response and multi-host consistency remain open until implemented and tested.