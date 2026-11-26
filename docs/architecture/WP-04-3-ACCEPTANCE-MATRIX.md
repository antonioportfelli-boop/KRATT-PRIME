# WP-04.3 — Acceptance and Adversarial Test Matrix

| Boundary | Test | Expected |
|---|---|---|
| Request | Missing/malformed payload digest | Reject |
| Contract | Operation not in manifest | Reject |
| Capability version | Unknown or omitted capability version | Reject |
| Principal | Required scope absent | Deny |
| Agent | Required scope absent | Deny |
| Integration | Required scope absent | Deny |
| Scope intersection | One of three grants is narrower | Use intersection only |
| Resource | Target outside trusted allow scope or explicitly denied | Deny |
| Lifecycle | Unverified, disabled or error registration | Deny |
| Approval | Missing verifier or invalid signature | Deny |
| Approval | Wrong actor, agent, provider, operation or target | Deny |
| Approval | Request digest missing or mismatched | Deny |
| Approval | Expired/future/overlong approval | Deny |
| Approval | Destructive operation without destructive approval | Deny |
| Replay | Nonce already consumed/revoked | Deny |
| Audit | Append-only audit persistence fails | Do not return a grant |
| Output | Caller forges an object matching grant fields | Reject branding |
| Write boundary | VERIFIED_READ_ONLY plus approval | Still deny WRITE |
| Write path | Test-only WRITE_ENABLED + verified digest-bound approval | Grant only after one-time consumption and audit |

## Exit criteria

No provider side effect is performed in WP-04.3. The next stage must consume only the branded grant, re-check current registration and cancellation/revocation, and pass a minimal invocation context to an operating-system-enforced isolated worker supervisor.
