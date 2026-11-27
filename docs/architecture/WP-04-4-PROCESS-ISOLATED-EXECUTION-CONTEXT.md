# WP-04.4 — Process-Isolated Adapter Invocation Context

Status: implementation candidate on \`feature/wp-04-4-process-isolated-adapter-context-2026-11-27\`, stacked on WP-04.3 Draft PR #64.  
Scope: consume a branded WP-04.3 grant, revalidate registration and current execution fences, require independently attested OS process/container isolation, and pass a minimal read-only invocation context.  
Non-goals: provider writes, credential brokering, a concrete Linux/container supervisor, production data stores, tenant isolation or live provider calls.

## Execution sequence

1. Call WP-04.3 authorization and accept only the module-branded grant object.
2. Re-read the adapter registration and compare revision, contract digest and artifact digest to the grant.
3. Require the current registration state to be \`VERIFIED_READ_ONLY\`.
4. Resolve the requested operation from the pinned manifest and require class \`READ\`.
5. Require the contract's execution mode to be \`PROCESS_ISOLATED\`; \`IN_PROCESS_TRUSTED\` and \`WORKER_ISOLATED\` are not accepted as security boundaries here.
6. Read the fixed worker supervisor's isolation profile and require a trusted verifier receipt.
7. Require all isolation properties: OS process/container boundary, provider-allowlisted network egress, read-only artifact + ephemeral temporary filesystem, and no raw secrets.
8. Recheck current policy, grant expiry, revocation and cancellation through the injected execution fence immediately before launch.
9. Commit a durable execution start/audit record before invoking the worker supervisor.
10. Pass a frozen, bounded invocation envelope containing pinned source coordinates, artifact digest, operation, exact request digest, scoped authorization reference and resource limits.
11. Validate the worker's result projection, recheck the fence and atomically record the outcome.
12. An unknown, malformed or unaudited result is never reported as success and is not automatically retried.

## Isolation boundary

This module does not claim that freezing a JavaScript object, using Node Worker Threads, or merely calling a method named \`runInRestrictedProcess\` provides isolation. The supervisor implementation and its environment must be independently attested by a trusted host verifier.

The required profile is:
- \`isolationClass: OS_PROCESS_CONTAINER\`;
- \`networkPolicy: PROVIDER_ALLOWLIST_ONLY\`;
- \`filesystemPolicy: READ_ONLY_ARTIFACT_AND_EPHEMERAL_TMP\`;
- \`credentialPolicy: NO_RAW_SECRETS\`.

The verifier must bind the exact supervisor policy digest to the adapter, provider, artifact digest, operation and requested scopes. The actual implementation must enforce OS identity separation, resource limits, restricted filesystem mounts, egress allowlists, process termination and safe artifact acquisition/digest verification.

## Invocation payload

The worker receives no provider credentials, approval envelope, signing key, raw authorization object, caller grant arrays or unrestricted store handles. It receives only a minimal immutable invocation descriptor and pinned artifact coordinates. The worker returns bounded metadata and an opaque result reference/digest; raw provider payloads are stored separately behind host policy.

## Current write boundary

WP-04.2 does not expose a WRITE_ENABLED transition. WP-04.3 preserves this. WP-04.4 rejects every non-READ operation even if a test fixture or future caller tries to supply a write-shaped grant. The initial process runner is read-only by design.

## Persistence contracts

The injected execution store must atomically persist:
- \`startWithAudit({ invocation, event })\` before worker launch;
- \`finishWithAudit({ invocationId, result, event })\` after the worker returns.

The production store must guarantee uniqueness of invocation IDs, immutable start evidence, a single terminal outcome, and durable audit append. Tests use an in-memory fake only.

## Current external dependencies / gaps

- A concrete process/container supervisor is not implemented in this repository slice.
- Isolation and policy attestations are host-injected; key lifecycle and verifier trust roots remain deployment-owned.
- Execution fence must query current cancellation, current grants/revocation, worker permit, and registration state at the effect boundary.
- No secrets or credentials are passed; read-only adapter flows requiring authentication await a separate least-privilege broker design.
- The store, isolation verifier and supervisor have not been tested in a staging or production environment.
- Tenant ID is not yet a first-class bound field; multi-tenant use remains blocked.

## Verification

\`\`\`sh
node --test packages/kratt-core/test/*.test.mjs packages/kratt-orchestrator/test/*.test.mjs
npm run typecheck
npm run build
\`\`\`

A passing suite demonstrates the host boundary contracts, not an independently isolated process deployment.
