# WP-01 — Authorization Hardening

Status: implementation committed to `feature/wp-01-authorization-hardening`; CI verification pending.

## Security boundary

`evaluatePolicy(task, evidence, trustedContext, security)` is a deterministic policy decision function. It is not itself a cryptographic trust root. The host must inject verifier callbacks that are owned by a trusted boundary and are not derived from task payloads or untrusted plugins.

- `verifyApproval(approval, binding) === true` is required for `WRITE` and `IRREVERSIBLE` policy actions.
- `verifyEvidence(record, binding) === true` is required before a `VERIFIED` record can satisfy a required evidence claim.
- Missing, throwing, or non-boolean verifier results fail closed.
- The evaluator never trusts `requested_authority` from the task.

## Approval binding

An approval contains exactly:

- `approval_id`, `request_id`, `provider`, `operation`
- `target.resource_type`, `target.resource_id`
- `branch`, `path`, `expires_at`

The request ID, provider, operation, target, branch, path and expiry are checked against the pending task before the trusted approval verifier is called. Approval must be unexpired at evaluation time.

The verifier should validate a signed or otherwise authenticated approval artifact against an independently controlled approval store/key. A plain object supplied by an agent is not an authenticated approval.

## Trusted context and scope

- Trusted context freshness defaults to 60 seconds; a policy may set `max_context_age_ms` from 1 to 300000.
- Future-dated contexts are rejected.
- Duplicate policy rules for an action return `BLOCKED`, independent of rule order.
- Branch constraints require an explicit `allowed_branches` entry.
- Path constraints require an explicit `allowed_paths` prefix match.
- Tasks in any state other than `PENDING` are denied.

## Policy rule example

```js
{
  action: "repo.write",
  required_authority: "repository.write",
  target_types: ["repository"],
  side_effect_class: "WRITE",
  allowed_branches: ["feature/wp-01-authorization-hardening"],
  allowed_paths: ["packages/kratt-core"]
}
```

## Acceptance coverage

The core suite covers missing/fake approval, request/provider/operation/target/branch/path mismatch, expired approval, verifier rejection, forged `VERIFIED` evidence, cancelled tasks, duplicate policies, stale/future contexts, branch/path escape, and duplicate evidence IDs.

## Operational limitations

- This patch introduces the verifier interface; it does not implement a production signing key, approval database, credential broker, or external executor.
- The host must provide secure verifier implementations and an authoritative clock.
- Policy path-prefix checks are lexical. A filesystem or Git adapter must additionally normalize paths and reject traversal/symlink escapes before performing an operation.
- This patch does not grant any GitHub, GitLab, deployment, or production capability by itself.
